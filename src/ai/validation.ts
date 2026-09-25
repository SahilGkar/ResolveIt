import type { RepairAction, RepairActionType, RepairTool } from '../core/models.js';
import { CreateFileTool } from '../repair/tools/create-file.js';
import { ModifyFileTool } from '../repair/tools/modify-file.js';
import { InstallDependencyTool } from '../repair/tools/install-dependency.js';
import { CreatePythonVenvTool } from '../repair/tools/create-python-venv.js';
import { TOOL_PARAMETER_ALLOWLIST, toolNameForActionType } from './context.js';

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
  'binary',
  'executablepath',
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

export function validateAIAction(
  input: AIValidationInput,
  workspaceRoot: string,
  actionId: string
): { action: RepairAction; toolName: string } | { rejection: string } {
  const resolved = resolveTool(input.type);
  if (!resolved) {
    return { rejection: `Unknown tool or action type: ${input.type}` };
  }
  const { tool, actionType } = resolved;

  const parameters = { ...(input.parameters as Record<string, unknown>) };

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

  inputs.forEach((input, index) => {
    const outcome = validateAIAction(input, workspaceRoot, `action-ai-${Date.now()}-${index}`);
    if ('rejection' in outcome) {
      rejections.push(outcome.rejection);
    } else {
      valid.push(outcome);
    }
  });

  return { valid, rejections };
}
