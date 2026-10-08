import { isWorkflowStep } from './model.js';

/**
 * Commands the workflow panel webview is allowed to request. Anything else —
 * including legacy hub commands — is dropped and logged, never executed.
 */
export const WORKFLOW_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  'workflow.setAiMode',
  'workflow.retryAi',
  'workflow.analyze',
  'workflow.cancelAnalyze',
  'workflow.reanalyze',
  'workflow.generatePlan',
  'workflow.toggleApproval',
  'workflow.approveAll',
  'workflow.denyAll',
  'workflow.apply',
  'workflow.verify',
  'workflow.finish',
  'workflow.returnToPlan',
  'workflow.retryInit',
  'workflow.restart',
  'workflow.gotoAiMode',
  'workflow.gotoProject',
]);

const COMMANDS_REQUIRING_ACTION_ID: ReadonlySet<string> = new Set(['workflow.toggleApproval']);

export interface ValidatedWorkflowMessage {
  readonly command: string;
  readonly actionId?: string;
  readonly step?: string;
}

function validActionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= 256 &&
    /^[A-Za-z0-9 _.:/-]+$/.test(value)
  );
}

export function validateWorkflowMessage(message: unknown): ValidatedWorkflowMessage | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  if (record['type'] !== 'command') {
    return undefined;
  }
  const command = record['command'];
  if (typeof command !== 'string' || !WORKFLOW_ALLOWED_COMMANDS.has(command)) {
    return undefined;
  }
  if (COMMANDS_REQUIRING_ACTION_ID.has(command)) {
    if (!validActionId(record['actionId'])) {
      return undefined;
    }
    return { command, actionId: record['actionId'] as string };
  }
  if (command === 'workflow.setAiMode') {
    const step = record['step'];
    if (typeof step !== 'string' || (step !== 'none' && step !== 'local' && step !== 'external')) {
      return undefined;
    }
    return { command, step };
  }
  return { command };
}

export function isWorkflowGoto(command: string): command is 'workflow.gotoAiMode' | 'workflow.gotoProject' {
  return command === 'workflow.gotoAiMode' || command === 'workflow.gotoProject';
}

export { isWorkflowStep };
