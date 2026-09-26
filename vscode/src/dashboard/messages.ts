export const DASHBOARD_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  'resolveit.analyzeProject',
  'resolveit.scan',
  'resolveit.diagnose',
  'resolveit.run',
  'resolveit.environment',
  'resolveit.requirements',
  'resolveit.repair',
  'resolveit.verify',
  'resolveit.generateRepairPlan',
  'resolveit.applyApprovedRepairs',
  'resolveit.approveAction',
  'resolveit.skipAction',
  'resolveit.reviewProblems',
  'resolveit.reviewRepairs',
  'resolveit.askAI',
  'resolveit.retryAI',
  'resolveit.showDetails',
  'resolveit.openSettings',
]);

const COMMANDS_REQUIRING_ACTION_ID: ReadonlySet<string> = new Set([
  'resolveit.approveAction',
  'resolveit.skipAction',
]);

export interface ValidatedDashboardMessage {
  readonly command: string;
  readonly actionId?: string;
}

export function validateDashboardMessage(message: unknown): ValidatedDashboardMessage | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  if (record['type'] !== 'command') {
    return undefined;
  }
  const command = record['command'];
  if (typeof command !== 'string' || !DASHBOARD_ALLOWED_COMMANDS.has(command)) {
    return undefined;
  }
  if (COMMANDS_REQUIRING_ACTION_ID.has(command)) {
    const actionId = record['actionId'];
    if (typeof actionId !== 'string' || actionId.trim() === '' || actionId.length > 256) {
      return undefined;
    }
    if (!/^[A-Za-z0-9 _.:/-]+$/.test(actionId)) {
      return undefined;
    }
    return { command, actionId };
  }
  return { command };
}
