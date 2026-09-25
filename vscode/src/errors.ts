import { redactSecrets } from './ui/output.js';
import { OperationBusyError, OperationCancelledError } from './operations.js';

export type ExtensionErrorKind =
  | 'no-workspace'
  | 'invalid-workspace'
  | 'config'
  | 'ai-unavailable'
  | 'permission-denied'
  | 'repair-failed'
  | 'verification-failed'
  | 'already-running'
  | 'cancelled'
  | 'unexpected';

export interface ClassifiedError {
  readonly kind: ExtensionErrorKind;
  readonly userMessage: string;
  readonly logDetail: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyError(error: unknown, context: string): ClassifiedError {
  if (error instanceof OperationCancelledError) {
    return {
      kind: 'cancelled',
      userMessage: 'ResolveIt operation was cancelled. Partial results were discarded.',
      logDetail: redactSecrets(`${context}: cancelled by user`),
    };
  }

  if (error instanceof OperationBusyError) {
    return {
      kind: 'already-running',
      userMessage: messageOf(error),
      logDetail: redactSecrets(`${context}: duplicate ${error.kind} invocation rejected`),
    };
  }

  const message = messageOf(error);

  if (/api[_-]?key|Bearer\s+\S+|ENOTFOUND|EAI_AGAIN/i.test(message) && /ai|model|provider|fetch|network/i.test(`${context} ${message}`)) {
    return {
      kind: 'ai-unavailable',
      userMessage: 'ResolveIt AI provider is unavailable. Falling back to deterministic planning.',
      logDetail: redactSecrets(`${context}: AI provider failure (${message})`),
    };
  }

  if (/ENOENT|ENOTDIR|invalid workspace|no such file/i.test(message)) {
    return {
      kind: 'invalid-workspace',
      userMessage: `${context}. The workspace folder is missing or no longer valid. Reopen the folder and try again. Reason: ${message}`,
      logDetail: redactSecrets(`${context}: invalid workspace (${message})`),
    };
  }

  if (/EACCES|EPERM|permission denied|not approved|denied/i.test(message)) {
    return {
      kind: 'permission-denied',
      userMessage: `${context}. Permission was denied. Reason: ${message}`,
      logDetail: redactSecrets(`${context}: permission issue (${message})`),
    };
  }

  if (/unknown (AI )?provider|invalid (AI )?configuration|not-configured/i.test(message)) {
    return {
      kind: 'config',
      userMessage: `${context}. Check the ResolveIt settings (resolveit.ai.*). Reason: ${message}`,
      logDetail: redactSecrets(`${context}: configuration issue (${message})`),
    };
  }

  return {
    kind: 'unexpected',
    userMessage: `${context}. Reason: ${message}`,
    logDetail: redactSecrets(`${context}: unexpected failure (${message})`),
  };
}

export function repairFailure(reason: string): ClassifiedError {
  return {
    kind: 'repair-failed',
    userMessage: `ResolveIt could not complete the repair. Reason: ${reason}`,
    logDetail: redactSecrets(`Repair failed: ${reason}`),
  };
}

export function verificationFailure(summary: string): ClassifiedError {
  return {
    kind: 'verification-failed',
    userMessage: `ResolveIt verification did not pass. ${summary}`,
    logDetail: redactSecrets(`Verification failed: ${summary}`),
  };
}
