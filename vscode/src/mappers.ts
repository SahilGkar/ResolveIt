import type {
  AIPlanningResult,
  Diagnostic,
  DiagnosticSeverity,
  RepairAction,
  RepairPlan,
} from '../../src/index.js';
import type { AIConfig } from '../../src/index.js';

export type SeverityGroup = 'Critical' | 'Errors' | 'Warnings' | 'Info';

export function severityGroup(severity: DiagnosticSeverity): SeverityGroup {
  switch (severity) {
    case 'critical':
      return 'Critical';
    case 'error':
      return 'Errors';
    case 'warning':
      return 'Warnings';
    case 'info':
    case 'hint':
    default:
      return 'Info';
  }
}

export function severityIcon(severity: DiagnosticSeverity): string {
  switch (severity) {
    case 'critical':
    case 'error':
      return '🔴';
    case 'warning':
      return '🟠';
    case 'info':
    case 'hint':
    default:
      return '🟡';
  }
}

export function diagnosticLabel(diagnostic: Diagnostic): string {
  return `${severityIcon(diagnostic.severity)} ${diagnostic.title}`;
}

export function diagnosticDescription(diagnostic: Diagnostic): string {
  return `${diagnostic.severity} · ${diagnostic.category}`;
}

export function diagnosticDetails(diagnostic: Diagnostic): string[] {
  const lines: string[] = [diagnostic.message];
  for (const item of diagnostic.evidence) {
    let line = `${item.source}: ${item.description}`;
    if (item.expected !== undefined) {
      line += ` (expected: ${String(item.expected)}`;
      if (item.actual !== undefined) {
        line += `, actual: ${String(item.actual)}`;
      }
      line += ')';
    } else if (item.actual !== undefined) {
      line += ` (actual: ${String(item.actual)})`;
    }
    lines.push(line);
  }
  if (diagnostic.affectedFiles && diagnostic.affectedFiles.length > 0) {
    lines.push(`File: ${diagnostic.affectedFiles.join(', ')}`);
  }
  if (diagnostic.remediationCandidates) {
    for (const candidate of diagnostic.remediationCandidates) {
      lines.push(`Suggested: ${candidate.description}`);
    }
  }
  return lines;
}

const EVENT_PROGRESS: Readonly<Record<string, string>> = {
  'observation-started': 'Observing project',
  'observation-completed': 'Inspecting environment',
  'analysis-completed': 'Analyzing diagnostics',
  'plan-created': 'Creating repair plan',
  'approval-requested': 'Awaiting approval',
  'approval-granted': 'Approval granted',
  'approval-denied': 'Approval denied',
  'action-started': 'Applying repair',
  'action-completed': 'Repair step completed',
  'action-failed': 'Repair step failed',
  'verification-started': 'Verifying',
  'verification-completed': 'Verification completed',
  replanning: 'Re-planning',
  resolved: 'Resolved',
  failed: 'Failed',
};

export function describeAgentEvent(type: string): string {
  return EVENT_PROGRESS[type] ?? type;
}

export function statusTextForIssues(count: number): string {
  if (count === 0) {
    return '$(check) ResolveIt';
  }
  return `$(warning) ResolveIt: ${count} issue${count === 1 ? '' : 's'}`;
}

export function statusTextForActivity(activity: string): string {
  return `$(sync~spin) ResolveIt: ${activity}`;
}

export interface AIStatusDisplay {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly available: boolean;
}

export function aiStatusForDisplay(
  sanitized: { provider: string; model?: string; baseUrl?: string; apiKeyConfigured: boolean },
  available: boolean
): AIStatusDisplay {
  return {
    provider: sanitized.provider,
    model: sanitized.model ?? '(not configured)',
    baseUrl: sanitized.baseUrl ?? '(not configured)',
    available,
  };
}

export interface VSCodeAISettings {
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly baseUrl?: unknown;
  readonly timeout?: unknown;
}

export function configToAIConfigOverrides(settings: VSCodeAISettings): Partial<AIConfig> {
  const overrides: {
    provider?: AIConfig['provider'];
    model?: string;
    baseUrl?: string;
    timeoutMs?: number;
  } = {};
  if (typeof settings.provider === 'string' && settings.provider.trim() !== '') {
    overrides.provider = settings.provider.trim() as AIConfig['provider'];
  }
  if (typeof settings.model === 'string' && settings.model.trim() !== '') {
    overrides.model = settings.model.trim();
  }
  if (typeof settings.baseUrl === 'string' && settings.baseUrl.trim() !== '') {
    overrides.baseUrl = settings.baseUrl.trim();
  }
  if (typeof settings.timeout === 'number' && Number.isFinite(settings.timeout) && settings.timeout > 0) {
    overrides.timeoutMs = Math.floor(settings.timeout);
  }
  return overrides;
}

export function planSummary(plan: RepairPlan): string {
  return `${plan.actions.length} action${plan.actions.length === 1 ? '' : 's'}`;
}

export function actionLines(action: RepairAction): string[] {
  const lines = [
    `${action.description} (${action.type})`,
    `Permission: ${action.permissionLevel}`,
    `Reversible: ${action.reversible === true ? 'yes' : 'no'}`,
  ];
  if (action.affectedFiles && action.affectedFiles.length > 0) {
    lines.push(`Files: ${action.affectedFiles.join(', ')}`);
  }
  if (action.estimatedImpact) {
    lines.push(`Impact: ${action.estimatedImpact}`);
  }
  return lines;
}

export function friendlyError(context: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `${context}. Reason: ${reason}`;
}

export function multiRootNotice(roots: ReadonlyArray<string>): string {
  return (
    `ResolveIt detected a multi-root workspace (${roots.length} folders). ` +
    `Only the first folder is analyzed in this version: ${roots[0] ?? 'none'}.`
  );
}

export function aiResultSummary(result: AIPlanningResult): string {
  return `${result.summary} (${result.actions.length} proposed action${result.actions.length === 1 ? '' : 's'})`;
}
