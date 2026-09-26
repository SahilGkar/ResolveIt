import type { AIPlanningResult, AIProposedAction, RepairAction, RepairResult } from '../../../src/index.js';
import type { ApprovalState } from '../state.js';

export type ActionLifecycle =
  | 'proposed'
  | 'awaiting-approval'
  | 'approved'
  | 'denied'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'verified';

export interface RepairCardModel {
  readonly id: string;
  readonly actionType: string;
  readonly target: string;
  readonly reason: string;
  readonly source: string;
  readonly scope: string;
  readonly risk: string;
  readonly proposedChange: string;
  readonly reversible: boolean;
  readonly approval: ApprovalState;
  readonly lifecycle: ActionLifecycle;
  readonly executionError?: string;
}

export interface AIReportModel {
  readonly provider: string;
  readonly model: string;
  readonly summary: string;
  readonly detected: number;
  readonly proposed: number;
  readonly approved: number;
  readonly executed: number;
  readonly verified: number;
  readonly cards: ReadonlyArray<RepairCardModel>;
}

const KNOWN_ACTION_TYPES: ReadonlySet<string> = new Set([
  'install-dependency',
  'update-manifest',
  'create-environment',
  'modify-configuration',
  'run-script',
  'install-tool',
  'upgrade-runtime',
  'apply-patch',
  'set-variable',
  'custom',
]);

export function isKnownActionType(type: string): boolean {
  return KNOWN_ACTION_TYPES.has(type);
}

export function scopeLabel(permissionLevel: string): string {
  switch (permissionLevel) {
    case 'read-only':
      return 'Read only';
    case 'project-modification':
      return 'Project change';
    case 'system-modification':
      return 'System change';
    default:
      return 'Requires approval';
  }
}

export function riskLabel(riskLevel: string): string {
  switch (riskLevel) {
    case 'read-only':
      return 'Read only';
    case 'project-modification':
      return 'Project environment';
    case 'system-modification':
      return 'System scope';
    default:
      return 'Requires approval';
  }
}

function targetLabel(action: RepairAction): string {
  const target = action.target ?? {};
  const parts: string[] = [];
  if (target.filePath) {
    parts.push(target.filePath);
  }
  if (target.toolId) {
    parts.push(target.toolId);
  }
  if (target.projectId) {
    parts.push(target.projectId);
  }
  if (target.environmentId) {
    parts.push(target.environmentId);
  }
  const params = action.parameters ?? {};
  for (const key of ['name', 'package', 'dependency', 'tool', 'runtime']) {
    const value = params[key];
    if (typeof value === 'string' && value.trim() !== '' && !parts.includes(value)) {
      parts.push(value);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : action.type;
}

function reasonLabel(action: RepairAction): string {
  if (action.estimatedImpact) {
    return action.estimatedImpact;
  }
  const params = action.parameters ?? {};
  const from = params['sourceFile'] ?? params['source'] ?? params['requiredBy'];
  if (typeof from === 'string' && from.trim() !== '') {
    return `Required by ${from}`;
  }
  return action.description;
}

export function toRepairCard(
  action: RepairAction,
  approval: ApprovalState,
  execution?: { result: RepairResult; verified: boolean; executing: boolean }
): RepairCardModel {
  let lifecycle: ActionLifecycle = 'proposed';
  if (execution?.executing === true) {
    lifecycle = 'executing';
  } else if (execution && !execution.result.success) {
    lifecycle = 'failed';
  } else if (execution?.verified === true) {
    lifecycle = 'verified';
  } else if (execution) {
    lifecycle = 'executed';
  } else if (approval === 'approved') {
    lifecycle = 'approved';
  } else if (approval === 'denied') {
    lifecycle = 'denied';
  } else {
    lifecycle = 'awaiting-approval';
  }
  return {
    id: action.id,
    actionType: action.type,
    target: targetLabel(action),
    reason: reasonLabel(action),
    source: (action.affectedFiles ?? []).join(', ') || 'project analysis',
    scope: scopeLabel(action.permissionLevel),
    risk: riskLabel(action.riskLevel),
    proposedChange: action.description,
    reversible: action.reversible === true,
    approval,
    lifecycle,
    executionError: execution && !execution.result.success ? execution.result.error ?? 'unknown error' : undefined,
  };
}

export function lifecycleLabel(lifecycle: ActionLifecycle): string {
  switch (lifecycle) {
    case 'proposed':
      return 'Proposed';
    case 'awaiting-approval':
      return 'Awaiting approval';
    case 'approved':
      return 'Approved';
    case 'denied':
      return 'Skipped';
    case 'executing':
      return 'Executing';
    case 'executed':
      return 'Executed';
    case 'failed':
      return 'Failed';
    case 'verified':
      return 'Verified';
  }
}

export interface AIReportInput {
  readonly provider: string;
  readonly model: string;
  readonly result: AIPlanningResult;
  readonly approvedCount: number;
  readonly executedCount: number;
  readonly verifiedCount: number;
}

export function toAIReport(input: AIReportInput): AIReportModel {
  return {
    provider: input.provider,
    model: input.model,
    summary: input.result.summary,
    detected: input.result.actions.length,
    proposed: input.result.actions.length,
    approved: input.approvedCount,
    executed: input.executedCount,
    verified: input.verifiedCount,
    cards: input.result.actions.map((action, index) => fromAIProposal(action, index)),
  };
}

function fromAIProposal(action: AIProposedAction, index: number): RepairCardModel {
  const params = action.parameters ?? {};
  const name = ['name', 'package', 'dependency', 'tool', 'runtime']
    .map((key) => params[key])
    .find((value): value is string => typeof value === 'string' && value.trim() !== '');
  return {
    id: `ai-proposal-${index}`,
    actionType: action.type,
    target: name ?? action.type,
    reason: action.rationale ?? 'Proposed by AI; awaiting Core validation.',
    source: 'AI proposal (unvalidated)',
    scope: 'Requires approval',
    risk: 'Requires approval',
    proposedChange: name ? `${action.type}: ${name}` : action.type,
    reversible: false,
    approval: 'awaiting',
    lifecycle: 'proposed',
  };
}

export function isDirectlyExecutable(_card: RepairCardModel): boolean {
  return false;
}

export function filterExecutableIds(cards: ReadonlyArray<RepairCardModel>, approvedIds: ReadonlyArray<string>): ReadonlyArray<string> {
  const approved = new Set(approvedIds);
  const known = new Map(cards.filter((card) => isKnownActionType(card.actionType)).map((card) => [card.id, card] as const));
  return [...approved].filter((id) => known.has(id));
}
