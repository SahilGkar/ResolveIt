import type { AIPlanningContext } from '../core/models.js';

export interface PlanningPrompt {
  readonly system: string;
  readonly user: string;
}

const SAFETY_INSTRUCTIONS = [
  'You are proposing actions.',
  'You are not executing actions.',
  'You cannot grant yourself permission.',
  'Only registered ResolveIt RepairTools may execute actions.',
  'Propose only actions whose type matches a listed tool name or a listed supported action type.',
  'Never propose shell commands, executable paths outside the listed parameters, or permission levels.',
  'If no listed tool can safely address a diagnostic, omit it: a deterministic fallback handles the rest.',
].join('\n');

export function buildPlanningPrompt(context: AIPlanningContext): PlanningPrompt {
  const toolLines = context.availableTools.map(
    (tool) =>
      `- ${tool.name}: ${tool.description} (parameters: ${tool.allowedParameters.join(', ') || 'none'}; permission: ${tool.permissionLevel})`
  );

  const system = [
    'You are the planning assistant for ResolveIt, a deterministic project environment diagnosis and resolution system.',
    'ResolveIt observes the workspace, runs deterministic diagnostics, and executes only approved actions through controlled RepairTools.',
    '',
    'Safety rules:',
    SAFETY_INSTRUCTIONS,
    '',
    'Available repair tools:',
    ...toolLines,
    '',
    'Permission constraints:',
    `- Maximum automatic risk level: ${context.constraints.maxRiskLevel}.`,
    `- Allowed action types: ${context.constraints.allowedActions.join(', ') || 'none'}.`,
    '- System modifications always require explicit user approval and must be omitted from your proposal.',
    '',
    'Expected structured output (JSON object only, no prose):',
    '{"summary": string, "reasoning"?: string, "confidence"?: number between 0 and 1,',
    ' "actions": [{"type": string, "parameters": object, "rationale"?: string}]}',
  ].join('\n');

  const user = [
    'Plan repairs for the following structured evidence.',
    '',
    `Workspace: ${context.workspaceSummary.projectCount} project(s) at ${context.workspaceSummary.rootPath}.`,
    `Projects: ${context.workspaceSummary.projects.map((p) => `${p.name} (${p.type})`).join(', ') || 'none'}.`,
    `Environment runtimes: ${context.environmentSummary.runtimes.map((r) => `${r.name} ${r.version}`).join(', ') || 'none'}.`,
    `Environment tools: ${context.environmentSummary.tools.map((t) => `${t.name} ${t.version}`).join(', ') || 'none'}.`,
    `Docker: available=${String(context.environmentSummary.dockerAvailable)} running=${String(context.environmentSummary.dockerRunning)}.`,
    '',
    `Requirements: ${JSON.stringify(context.requirements)}`,
    '',
    `Blocking diagnostics: ${JSON.stringify(context.diagnostics)}`,
    '',
    `Previous failed attempts (do not repeat these fingerprints): ${JSON.stringify(context.previousAttempts)}`,
    '',
    `Last verification: ${context.verification ? JSON.stringify(context.verification) : 'none'}.`,
    '',
    'Respond with the JSON object only.',
  ].join('\n');

  return { system, user };
}
