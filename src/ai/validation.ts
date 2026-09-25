import type { RepairAction, RepairActionType, RepairTool } from '../core/models.js';
import { CreateFileTool } from '../repair/tools/create-file.js';
import { ModifyFileTool } from '../repair/tools/modify-file.js';
import { InstallDependencyTool } from '../repair/tools/install-dependency.js';
import { CreatePythonVenvTool } from '../repair/tools/create-python-venv.js';
import { TOOL_PARAMETER_ALLOWLIST, toolNameForActionType } from './context.js';
import { SECURITY_LIMITS, byteLength, parameterDepth } from '../safety/limits.js';
import { checkWorkspaceContainment } from '../safety/paths.js';
import { createId } from '../safety/ids.js';

export interface AIValidationInput {
  readonly type: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly rationale?: string;
}

export interface ValidatedAIAction {
  readonly action: RepairAction;
  readonly toolName: string;
}

export interface AIValidationResult {
  readonly valid: ReadonlyArray<ValidatedAIAction>;
  readonly rejections: ReadonlyArray<string>;
}

const PRIVILEGE_KEYS = new Set([
  'permissionlevel',
  'permission',
  'risklevel',
  'risk',
  'approval',
  'approved',
  'allow',
  'bypass',
  'elevation',
  'requiresElevation',
]);

const COMMAND_KEYS = new Set([
  'command',
  'commands',
  'shell',
  'exec',
  'execute',
  'run',
  'script',
  'scriptpath',
  'spawn',
  'spawnsync',
  'childprocess',
  'binary',
  'executablepath',
  'eval',
]);

const PRIMARY_ACTION_TYPE: Readonly<Record<string, RepairActionType>> = {
  'create-file': 'create-environment',
  'modify-file': 'modify-configuration',
  'install-dependency': 'install-dependency',
  'create-python-venv': 'create-environment',
};

function defaultTools(): RepairTool[] {
  return [new CreateFileTool(), new ModifyFileTool(), new InstallDependencyTool(), new CreatePythonVenvTool()];
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

function resolveTool(type: string): { tool: RepairTool; actionType: RepairActionType } | undefined {
  const tools = defaultTools();
  for (const tool of tools) {
    if (tool.name === type) {
      const primary = PRIMARY_ACTION_TYPE[tool.name];
      if (primary) {
        return { tool, actionType: primary };
      }
    }
  }
  for (const tool of tools) {
    if ((tool.supportedActionTypes as ReadonlyArray<string>).includes(type)) {
      return { tool, actionType: type as RepairActionType };
    }
  }
  const mapped = toolNameForActionType(type);
  if (mapped) {
    const tool = tools.find((candidate) => candidate.name === mapped);
    const primary = PRIMARY_ACTION_TYPE[mapped];
    if (tool && primary) {
      return { tool, actionType: primary };
    }
  }
  return undefined;
}

function isPathParameter(toolName: string, key: string): boolean {
  if (toolName === 'install-dependency') {
    return false;
  }
  return normalizeKey(key) === 'path';
}

export function validateAIAction(
  input: AIValidationInput,
  workspaceRoot: string,
  actionId: string
): { action: RepairAction; toolName: string } | { rejection: string } {
  if (typeof input.type !== 'string' || input.type.trim() === '' || input.type.length > 128) {
    return { rejection: `Invalid AI action type: ${String(input.type).slice(0, 64)}` };
  }
  const resolved = resolveTool(input.type);
  if (!resolved) {
    return { rejection: `Unknown tool or action type: ${input.type}` };
  }
  const { tool, actionType } = resolved;

  if (!input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters)) {
    return { rejection: `AI action ${input.type} parameters must be an object` };
  }

  const parameters = { ...(input.parameters as Record<string, unknown>) };

  let parameterBytes = 0;
  try {
    parameterBytes = byteLength(JSON.stringify(parameters));
  } catch {
    return { rejection: `AI action ${input.type} parameters are not serializable (possible recursive payload)` };
  }
  if (parameterBytes > SECURITY_LIMITS.maxAiParameterBytes) {
    return { rejection: `AI action ${input.type} parameters exceed maximum size` };
  }
  if (parameterDepth(parameters) > SECURITY_LIMITS.maxAiParameterDepth) {
    return { rejection: `AI action ${input.type} parameters are too deeply nested (possible recursive payload)` };
  }

  for (const key of Object.keys(parameters)) {
    const normalized = normalizeKey(key);
    if ([...PRIVILEGE_KEYS].some((privileged) => normalizeKey(privileged) === normalized)) {
      return { rejection: `Permission escalation attempt in action ${input.type}: parameter ${key}` };
    }
    if ([...COMMAND_KEYS].some((command) => normalizeKey(command) === normalized)) {
      return { rejection: `Arbitrary command field in action ${input.type}: parameter ${key}` };
    }
  }

  const allowed = new Set((TOOL_PARAMETER_ALLOWLIST[tool.name] ?? []).map(normalizeKey));
  for (const key of Object.keys(parameters)) {
    if (key === 'workspaceRoot') {
      continue;
    }
    if (!allowed.has(normalizeKey(key))) {
      return { rejection: `Unsupported parameter for ${tool.name}: ${key}` };
    }
  }

  for (const [key, value] of Object.entries(parameters)) {
    if (isPathParameter(tool.name, key) && typeof value === 'string') {
      const containment = checkWorkspaceContainment(workspaceRoot, value, { rejectAbsolutePaths: true });
      if (!containment.ok) {
        return { rejection: `Unsafe path in AI action ${input.type}: ${containment.error}` };
      }
    }
    if (typeof value === 'string' && byteLength(value) > SECURITY_LIMITS.maxAiParameterBytes) {
      return { rejection: `Oversized parameter value in AI action ${input.type}: ${key}` };
    }
  }

  if (typeof input.rationale === 'string' && input.rationale.length > 4000) {
    return { rejection: `Oversized rationale in AI action ${input.type}` };
  }

  const targetFile = parameters['path'];
  const action: RepairAction = {
    id: actionId,
    type: actionType,
    permissionLevel: tool.permissionLevel,
    description: input.rationale ?? `AI-proposed ${tool.name} action`,
    target: typeof targetFile === 'string' ? { filePath: targetFile } : {},
    parameters: { ...parameters, workspaceRoot },
    affectedFiles: typeof targetFile === 'string' ? [targetFile] : [],
    reversible: tool.permissionLevel !== 'system-modification',
    riskLevel: tool.permissionLevel,
    prerequisites: [],
  };

  const validation = tool.validate(action);
  if (!validation.valid) {
    return { rejection: `AI action failed ${tool.name} validation: ${validation.errors.join('; ')}` };
  }

  return { action, toolName: tool.name };
}

export function validateAIPlan(
  inputs: ReadonlyArray<AIValidationInput>,
  workspaceRoot: string
): AIValidationResult {
  const valid: ValidatedAIAction[] = [];
  const rejections: string[] = [];

  const bounded = inputs.slice(0, SECURITY_LIMITS.maxAiActions);
  if (inputs.length > SECURITY_LIMITS.maxAiActions) {
    rejections.push(
      `AI proposed too many actions (${inputs.length}); only the first ${SECURITY_LIMITS.maxAiActions} were considered`
    );
  }

  bounded.forEach((input, index) => {
    const outcome = validateAIAction(input, workspaceRoot, createId(`action-ai-${index}`));
    if ('rejection' in outcome) {
      rejections.push(outcome.rejection);
    } else {
      valid.push(outcome);
    }
  });

  return { valid, rejections };
}
