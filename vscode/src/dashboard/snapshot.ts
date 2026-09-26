import type { ExtensionState } from '../state.js';
import type { DashboardSnapshot } from './model.js';

export function snapshotFromState(
  state: ExtensionState,
  options: { readonly hasWorkspace: boolean; readonly workspaceName?: string } = { hasWorkspace: false }
): DashboardSnapshot {
  const diagnostics = state.getDiagnostics();
  const plan = state.getRepairPlan();
  const execution = state.getExecution();
  const verification = state.getLastVerification();
  const ai = state.getAIStatus();
  const requirements = state.getRequirements().flatMap((parsed) => [...parsed.requirements]);
  return {
    hasWorkspace: options.hasWorkspace,
    workspaceName: options.workspaceName,
    hasScanned: state.getHasScanned(),
    activeOperation: state.getActiveOperation(),
    diagnostics: [...diagnostics],
    blockingCount: state.blockingCount(),
    requirementsCount: requirements.length,
    environmentReady: state.getEnvironment() ? true : undefined,
    aiAvailable: ai?.available ?? false,
    aiProvider: ai?.provider,
    aiModel: ai?.model,
    hasPlan: plan !== undefined,
    planActionCount: plan?.actions.length ?? 0,
    planDecidedCount: state.getDecidedCount(),
    planApprovedCount: state.getApprovedIds().length,
    planStale: state.isPlanStale(),
    hasExecution: execution !== undefined,
    executionSucceeded: execution?.results.filter((entry) => entry.result.success).length ?? 0,
    executionFailed: execution?.results.filter((entry) => !entry.result.success).length ?? 0,
    verificationResolved: verification?.resolved.length ?? 0,
    verificationRemaining: verification?.remaining.length ?? 0,
    hasVerification: verification !== undefined,
    lastRunStatus: state.getLastRun()?.status,
    errorMessage: state.getLastError()?.message,
  };
}
