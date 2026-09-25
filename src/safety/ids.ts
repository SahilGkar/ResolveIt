import { randomUUID } from 'crypto';

export function createId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function createActionId(): string {
  return createId('action');
}

export function createPlanId(): string {
  return createId('plan');
}

export function createAuditId(): string {
  return createId('audit');
}

export function createSnapshotId(actionId: string): string {
  return `snapshot-${actionId}-${randomUUID()}`;
}

export function createRunId(): string {
  return createId('run');
}

export function createDiagnosticId(): string {
  return createId('diag');
}

export function createRemediationId(): string {
  return createId('rem');
}
