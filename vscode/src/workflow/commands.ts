import * as vscode from 'vscode';
import type { ExtensionState } from '../state.js';
import type { CoreClient } from '../core.js';
import type { AIConfig } from '../../../src/index.js';
import { OperationCoordinator, type OperationKind, type OperationToken } from '../operations.js';
import { classifyError, repairFailure, verificationFailure } from '../errors.js';
import type { ClassifiedError } from '../errors.js';
import type { Logger } from '../ui/output.js';

export interface WorkflowCommandContext {
  readonly state: ExtensionState;
  readonly logger: Logger;
  readonly core: CoreClient;
  readonly showMessage: (message: string) => void;
  readonly showWarning: (message: string) => void;
  readonly showError: (message: string) => void;
  readonly showProgress: <T>(title: string, task: (report: (msg: string) => void) => Promise<T>) => Promise<T>;
  readonly showCancellableProgress: <T>(title: string, task: (report: (msg: string) => void, token: { isCancellationRequested: boolean; onCancellationRequested: (cb: () => void) => void }) => Promise<T>) => Promise<T>;
  readonly getAIConfig: () => AIConfig;
  readonly getMaxIterations: () => number;
  readonly getWorkspaceRoot: () => string;
  readonly openFile: (absolutePath: string) => Promise<void>;
  readonly postMessage: (message: unknown) => void;
}

function requireRoot(ctx: WorkflowCommandContext): string | undefined {
  const root = ctx.getWorkspaceRoot();
  if (!root) {
    ctx.showMessage('ResolveIt needs an open folder. Open a folder workspace first.');
    return undefined;
  }
  return root;
}

function reportClassified(ctx: WorkflowCommandContext, classified: ClassifiedError, _statusHint: string): void {
  if (classified.kind === 'cancelled') {
    ctx.showMessage(classified.userMessage);
    ctx.logger.info(classified.logDetail);
    return;
  }
  if (classified.kind === 'already-running') {
    ctx.showMessage(classified.userMessage);
    ctx.logger.info(classified.logDetail);
    return;
  }
  ctx.showError(classified.userMessage);
  ctx.logger.error(classified.logDetail);
}

export function createWorkflowCommandHandlers(ctx: WorkflowCommandContext): Record<string, (actionId?: string, step?: string, data?: unknown) => Promise<void>> {
  const coordinator = new OperationCoordinator();
  const handlers: Record<string, (actionId?: string, step?: string, data?: unknown) => Promise<void>> = {};

  const guarded = (kind: OperationKind, task: (root: string, token: OperationToken) => Promise<void>) => {
    return async (): Promise<void> => {
      const root = requireRoot(ctx);
      if (!root) return;
      try {
        await ctx.showCancellableProgress(`ResolveIt: ${kind}`, async (report, token) => {
          await coordinator.run(kind, root, async (opToken) => {
            // Route VS Code cancellation into the coordinator so in-flight work
            // observes it at its next checkpoint instead of throwing here.
            token.onCancellationRequested(() => {
              coordinator.cancel(kind, root);
            });
            await task(root, opToken);
          });
        });
      } catch (error) {
        reportClassified(ctx, classifyError(error, `ResolveIt ${kind}`), `ResolveIt: ${kind} failed`);
      }
      ctx.postMessage({ type: 'refresh' });
    };
  };

  handlers['workflow.setAiMode'] = async (_actionId?: string, step?: string): Promise<void> => {
    if (step !== 'none' && step !== 'local' && step !== 'external') {
      ctx.logger.warn(`Workflow requested an unknown AI mode (${step ?? 'missing'}); ignoring it.`);
      return;
    }
    const config = vscode.workspace.getConfiguration('resolveit');
    await config.update('ai.provider', step, vscode.ConfigurationTarget.Global);
    ctx.postMessage({ type: 'refresh' });
  };

  handlers['workflow.retryAi'] = async (): Promise<void> => {
    const root = ctx.getWorkspaceRoot();
    try {
      const status = await ctx.core.aiStatus(ctx.getAIConfig());
      if (root && root !== ctx.getWorkspaceRoot()) {
        return;
      }
      ctx.state.setAIStatus({ provider: status.provider, model: status.model, baseUrl: status.baseUrl, available: status.available });
      if (status.available) {
        ctx.showMessage(`ResolveIt: AI available (${status.provider} · ${status.model}).`);
      } else {
        ctx.showWarning('ResolveIt: AI is still unavailable. Deterministic diagnostics remain usable.');
      }
      ctx.logger.info(`AI provider: ${status.provider} (${status.available ? 'available' : 'unavailable'}).`);
    } catch (error) {
      reportClassified(ctx, classifyError(error, 'ResolveIt AI retry'), 'ResolveIt: AI retry failed');
    }
    ctx.postMessage({ type: 'refresh' });
  };

  handlers['workflow.analyze'] = guarded('analyze', async (root, token) => {
    const phase = (activity: string): void => {
      ctx.postMessage({ type: 'progress', activity });
    };
    try {
      phase('Discovering project…');
      const workspace = await ctx.core.scanProject(root);
      token.throwIfCancelled();
      const first = workspace.projects[0];
      ctx.state.setProjectName(first ? first.name : '(no projects)');
      
      phase('Checking environment…');
      const environment = await ctx.core.environmentInfo();
      ctx.state.setEnvironment(environment);
      token.throwIfCancelled();
      
      phase('Reading requirements…');
      const requirements = await ctx.core.projectRequirements(root);
      ctx.state.setRequirements(requirements);
      token.throwIfCancelled();
      
      phase('Running diagnostics…');
      const diagnostics = await ctx.core.diagnoseProject(root);
      ctx.state.setDiagnostics(diagnostics);
      ctx.state.markScanned();
      ctx.state.clearLastError();
      
      const blocking = ctx.state.blockingCount();
      ctx.logger.info(`Analyze ${root}: ${workspace.projects.length} project(s), ${diagnostics.length} diagnostic(s), ${blocking} blocking.`);
      if (blocking === 0) {
        ctx.showMessage('ResolveIt: project looks healthy. No blocking diagnostics found.');
      } else {
        ctx.showMessage(`ResolveIt: found ${blocking} blocking issue${blocking === 1 ? '' : 's'}.`);
      }
    } finally {
      ctx.postMessage({ type: 'refresh' });
    }
  });

  handlers['workflow.cancelAnalyze'] = async (): Promise<void> => {
    const root = ctx.getWorkspaceRoot();
    if (root) {
      coordinator.cancel('analyze', root);
    }
    ctx.postMessage({ type: 'refresh' });
  };

  handlers['workflow.reanalyze'] = handlers['workflow.analyze'];

  handlers['workflow.generatePlan'] = guarded('repair', async (root, token) => {
    if (!ctx.state.getHasScanned()) {
      ctx.showMessage('ResolveIt: analyze the project first, then generate a repair plan.');
      return;
    }
    ctx.state.clearLastError();
    ctx.postMessage({ type: 'progress', activity: 'Generating repair plan…' });

    try {
      const aiConfig = ctx.getAIConfig();
      const { plan, diagnostics, aiUsed, aiRejections, fallbackReason, manualActions } =
        await ctx.core.planRepairsSmart(root, aiConfig);
      token.throwIfCancelled();
      ctx.state.setDiagnostics(diagnostics);
      ctx.state.markScanned();

      if (plan.actions.length === 0) {
        ctx.state.clearRepairPlan();
        ctx.showMessage('ResolveIt found no automated repairs. Manual action may be required.');
        return;
      }

      ctx.state.setRepairPlan(plan, plan.description, aiUsed);
      const notices: string[] = [];
      if (!aiUsed && aiConfig.provider !== 'none' && fallbackReason) {
        notices.push(`AI planning fell back to deterministic planning: ${fallbackReason}`);
      }
      for (const rejection of aiRejections) {
        notices.push(`AI proposal rejected by Core validation: ${rejection}`);
      }
      for (const manual of manualActions) {
        notices.push(`Manual action required: ${manual.description}`);
      }
      ctx.state.setRepairPlanNotices(notices);
      ctx.logger.info(
        `Repair plan (${aiUsed ? 'AI-generated' : 'deterministic'}, ${plan.actions.length} action(s)): ${plan.description}`
      );
      if (!aiUsed && aiConfig.provider !== 'none' && fallbackReason) {
        ctx.showWarning(`ResolveIt AI planning fell back to deterministic planning: ${fallbackReason}`);
        ctx.logger.warn(`AI planning fallback: ${fallbackReason}`);
      }
      if (aiRejections.length > 0) {
        ctx.logger.warn(`AI proposals rejected by Core validation: ${aiRejections.join('; ')}`);
      }
      if (manualActions.length > 0) {
        ctx.showMessage(
          `Manual action required: ${manualActions.map((manual) => manual.description).join('; ')}`
        );
      }
      ctx.showMessage(
        `Repair plan ready (${aiUsed ? 'AI-generated' : 'deterministic'}): ` +
          `${plan.actions.length} proposed change(s). Review before applying.`
      );
    } finally {
      ctx.postMessage({ type: 'refresh' });
    }
  });

  handlers['workflow.toggleApproval'] = async (actionId?: string): Promise<void> => {
    if (!actionId) return;
    const plan = ctx.state.getRepairPlan();
    if (!plan) return;
    if (!plan.actions.some(a => a.id === actionId)) return;
    
    const currentApproval = ctx.state.getApproval(actionId);
    const newApproval = currentApproval === 'approved' ? false : true;
    ctx.state.setApproval(actionId, newApproval);
    ctx.logger.info(`Repair action ${actionId}: ${newApproval ? 'approved' : 'denied'}`);
    ctx.postMessage({ type: 'refresh' });
  };

  handlers['workflow.approveAll'] = async (): Promise<void> => {
    const plan = ctx.state.getRepairPlan();
    if (!plan) return;

    // Bulk approval never escalates system-level actions. A system modification
    // (runtime upgrade, tool install, ...) always needs an explicit per-action
    // decision, matching the Core permission policy that requires confirmation
    // for system modifications.
    let approved = 0;
    let skippedSystem = 0;
    for (const action of plan.actions) {
      if (action.riskLevel === 'system-modification' || action.permissionLevel === 'system-modification') {
        skippedSystem += 1;
        continue;
      }
      if (ctx.state.getApproval(action.id) !== 'approved') {
        ctx.state.setApproval(action.id, true);
        approved += 1;
      }
    }
    ctx.logger.info(`Approved ${approved} action(s) in bulk; ${skippedSystem} system-level action(s) left for individual review.`);
    if (skippedSystem > 0) {
      ctx.showMessage(
        `ResolveIt approved ${approved} change${approved === 1 ? '' : 's'}. ` +
          `${skippedSystem} system-level change${skippedSystem === 1 ? '' : 's'} still need${skippedSystem === 1 ? 's' : ''} your individual review.`
      );
    }
    ctx.postMessage({ type: 'refresh' });
  };

  handlers['workflow.denyAll'] = async (): Promise<void> => {
    const plan = ctx.state.getRepairPlan();
    if (!plan) return;
    
    for (const action of plan.actions) {
      const approval = ctx.state.getApproval(action.id);
      if (approval !== 'denied') {
        ctx.state.setApproval(action.id, false);
      }
    }
    ctx.logger.info(`Denied all ${plan.actions.length} actions`);
    ctx.postMessage({ type: 'refresh' });
  };

  handlers['workflow.apply'] = guarded('repair', async (root, token) => {
    const plan = ctx.state.getRepairPlan();
    if (!plan) {
      ctx.showMessage('ResolveIt: no repair plan available. Generate a repair plan first.');
      return;
    }
    if (ctx.state.isPlanStale()) {
      ctx.showWarning('ResolveIt: diagnostics changed since this plan was created. Generate a fresh plan before applying.');
      return;
    }
    const approved = ctx.state.getApprovedIds();
    if (approved.length === 0) {
      ctx.showMessage('ResolveIt: approve at least one repair before applying.');
      return;
    }
    ctx.state.clearLastError();
    
    const before = ctx.state.getDiagnostics();
    ctx.postMessage({ type: 'progress', activity: 'Applying approved repairs…' });
    
    try {
      const execution = await ctx.core.executeApproved(root, plan, approved);
      token.throwIfCancelled();

      // The executor iterates every action in the plan and records a decision for
      // each one. Actions the user did not approve come back as
      // "Action not approved", which is a *decision*, not a failure. Only outcomes
      // for approved actions are treated as execution results here, so a partial
      // approval can never be reported as a failed repair.
      const approvedSet = new Set(approved);
      const approvedResults = execution.results.filter((entry) => approvedSet.has(entry.action.id));
      const failed = approvedResults.filter((entry) => !entry.result.success);
      const succeeded = approvedResults.filter((entry) => entry.result.success);
      const skipped = execution.results.length - approvedResults.length;

      ctx.state.setExecution({
        results: approvedResults,
        success: failed.length === 0,
        timestamp: new Date(),
      });

      ctx.logger.info(
        `Apply: ${approved.length} approved, ${succeeded.length} succeeded, ${failed.length} failed, ${skipped} not approved (skipped).`
      );

      if (failed.length > 0) {
        const classified = repairFailure(failed.map((entry) => entry.result.error ?? 'unknown error').join('; '));
        ctx.showError(classified.userMessage);
        ctx.logger.error(classified.logDetail);
        ctx.state.setLastError(classified.userMessage);
      } else if (skipped > 0) {
        ctx.showMessage(
          `ResolveIt applied ${succeeded.length} approved change${succeeded.length === 1 ? '' : 's'}. ${skipped} action${skipped === 1 ? ' was' : 's were'} not approved and ${skipped === 1 ? 'was' : 'were'} skipped.`
        );
      }
      
      ctx.postMessage({ type: 'progress', activity: 'Verifying changes…' });
      const verification = await ctx.core.verifyAgainstPrevious(root, before);
      token.throwIfCancelled();
      
      ctx.state.setLastVerification({ resolved: verification.resolved, remaining: verification.remaining, timestamp: new Date() });
      ctx.state.setDiagnostics(verification.current);
      ctx.logger.info(`Verification: ${verification.resolved.length} resolved, ${verification.remaining.length} remaining.`);
      
      if (verification.remaining.length > 0) {
        const classified = verificationFailure(`${verification.remaining.length} blocking diagnostic(s) remain.`);
        ctx.showWarning(classified.userMessage);
        ctx.logger.warn(classified.logDetail);
      } else if (failed.length === 0) {
        ctx.showMessage(`ResolveIt repair verified: ${verification.resolved.length} resolved, nothing remaining.`);
      }
    } finally {
      ctx.postMessage({ type: 'refresh' });
    }
  });

  handlers['workflow.verify'] = guarded('verify', async (root, token) => {
    const previous = ctx.state.getDiagnostics();
    ctx.state.clearLastError();
    ctx.postMessage({ type: 'progress', activity: 'Verifying project…' });
    try {
      const verification = await ctx.core.verifyAgainstPrevious(root, previous);
      token.throwIfCancelled();
      ctx.state.setLastVerification({ resolved: verification.resolved, remaining: verification.remaining, timestamp: new Date() });
      ctx.state.setDiagnostics(verification.current);
      ctx.logger.info(`Verification: ${verification.resolved.length} resolved, ${verification.remaining.length} remaining.`);
      if (verification.remaining.length > 0) {
        ctx.showWarning(
          `ResolveIt verification: ${verification.resolved.length} resolved, ${verification.remaining.length} remaining.`
        );
      } else {
        ctx.showMessage(
          verification.resolved.length > 0 || previous.length > 0
            ? `ResolveIt verification: ${verification.resolved.length} resolved, nothing remaining.`
            : 'ResolveIt verification: project looks healthy, nothing to resolve.'
        );
      }
    } finally {
      ctx.postMessage({ type: 'refresh' });
    }
  });

  handlers['workflow.testProject'] = async (): Promise<void> => {    const root = requireRoot(ctx);
    if (!root) return;

    ctx.state.setProjectTest({ running: true, attempted: false, success: false, exitCode: -1, output: '', message: 'Testing project…' });
    ctx.postMessage({ type: 'refresh' });

    try {
      // Runs the project's own allowlisted npm script through the Core safe command
      // runner. It never invents a command and never repairs anything.
      const result = await ctx.core.testProject(root);

      ctx.state.setProjectTest({
        running: false,
        ...(result.command ? { commandLabel: result.command.label } : {}),
        attempted: result.attempted,
        success: result.success,
        exitCode: result.exitCode,
        output: [result.stdout, result.stderr].filter((part) => part.length > 0).join('\n').slice(0, 4000),
        message: result.message,
      });

      if (!result.attempted) {
        ctx.showWarning(result.message);
      } else if (result.success) {
        ctx.showMessage(`${result.command?.label ?? 'Project test'}: ${result.message}`);
      } else {
        ctx.showWarning(`${result.command?.label ?? 'Project test'}: ${result.message}`);
      }
      ctx.logger.info(`Project test (${result.command?.label ?? 'none'}): ${result.message}`);
    } catch (error) {
      const classified = classifyError(error, 'ResolveIt project test');
      ctx.state.setProjectTest({
        running: false,
        attempted: false,
        success: false,
        exitCode: -1,
        output: '',
        message: classified.userMessage,
      });
      ctx.showError(classified.userMessage);
      ctx.logger.error(classified.logDetail);
    }
    ctx.postMessage({ type: 'refresh' });
  };

  handlers['workflow.returnToPlan'] = async (): Promise<void> => {
    // Preserve why the previous attempt failed before dropping the result, so the
    // repair plan can explain it instead of the information simply disappearing.
    const verification = ctx.state.getLastVerification();
    if (verification) {
      ctx.state.recordVerificationSummary({
        resolved: [...verification.resolved],
        remaining: [...verification.remaining],
        message:
          verification.remaining.length === 0
            ? 'Previous attempt verified successfully.'
            : `Previous attempt did not resolve ${verification.remaining.length} blocking issue(s).`,
        timestamp: verification.timestamp,
      });
    }
    // Clearing the verification result is what allows the workflow to leave the
    // verify/failed screen and reach the repair plan again.
    ctx.state.clearLastVerification();
    ctx.state.clearLastError();
    ctx.state.setProjectTest(undefined);

    const root = ctx.getWorkspaceRoot();
    if (root && ctx.state.getHasScanned()) {
      const { plan, aiUsed } = await ctx.core.planRepairsSmart(root, ctx.getAIConfig());
      if (plan.actions.length > 0) {
        ctx.state.setRepairPlan(plan, plan.description, aiUsed);
      } else {
        ctx.state.clearRepairPlan();
        ctx.showMessage('ResolveIt found no automated repairs for the remaining problems.');
      }
    } else {
      ctx.state.clearRepairPlan();
    }
    ctx.postMessage({ type: 'refresh' });
  };

  handlers['workflow.retryInit'] = async (): Promise<void> => {
    ctx.state.clearLastError();
    ctx.logger.info('Workflow initialization retried on user request.');
    ctx.postMessage({ type: 'refresh' });
  };

  handlers['workflow.restart'] = async (): Promise<void> => {
    const root = ctx.getWorkspaceRoot();
    if (root) {
      ctx.state.bindWorkspace(root);
    }
    ctx.postMessage({ type: 'refresh' });
  };

  return handlers;
}