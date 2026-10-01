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
            token.onCancellationRequested(() => opToken.throwIfCancelled());
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
    if (!step) return;
    const config = vscode.workspace.getConfiguration('resolveit');
    await config.update('ai.provider', step, vscode.ConfigurationTarget.Global);
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
      const { plan, diagnostics } = await ctx.core.planRepairs(root);
      token.throwIfCancelled();
      ctx.state.setDiagnostics(diagnostics);
      ctx.state.markScanned();
      
      if (plan.actions.length === 0) {
        ctx.state.clearRepairPlan();
        ctx.showMessage('ResolveIt found no automated repairs. Manual action may be required.');
        return;
      }
      
      ctx.state.setRepairPlan(plan, plan.description);
      ctx.logger.info(`Repair plan: ${plan.actions.length} action(s)`);
      ctx.showMessage(`Repair plan ready: ${plan.actions.length} proposed change(s). Review before applying.`);
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
    
    for (const action of plan.actions) {
      const approval = ctx.state.getApproval(action.id);
      if (approval !== 'approved') {
        ctx.state.setApproval(action.id, true);
      }
    }
    ctx.logger.info(`Approved all ${plan.actions.length} actions`);
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
      
      ctx.state.setExecution({ results: execution.results, success: execution.success, timestamp: new Date() });
      
      const failed = execution.results.filter((entry) => !entry.result.success);
      const succeeded = execution.results.filter((entry) => entry.result.success);
      ctx.logger.info(`Apply: ${approved.length} approved, ${succeeded.length} succeeded, ${failed.length} failed.`);
      
      if (failed.length > 0) {
        const classified = repairFailure(failed.map((entry) => entry.result.error ?? 'unknown error').join('; '));
        ctx.showError(classified.userMessage);
        ctx.logger.error(classified.logDetail);
        ctx.state.setLastError(classified.userMessage);
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

  handlers['workflow.testProject'] = async (): Promise<void> => {
    const root = requireRoot(ctx);
    if (!root) return;
    
    try {
      await ctx.showCancellableProgress('ResolveIt: Testing project', async (report, token) => {
        await coordinator.run('run', root, async (opToken) => {
          token.onCancellationRequested(() => opToken.throwIfCancelled());
          
          const { result } = await ctx.core.runAgent({
            workspaceRoot: root,
            dryRun: false,
            aiConfig: ctx.getAIConfig(),
            maxIterations: ctx.getMaxIterations(),
            approvalCallback: async (_repairPlan) => {
              const approved = await new Promise<string[]>((resolve) => {
                // For test runs, we'll use a simplified approval - in practice this would need UI
                resolve([]);
              });
              return approved;
            },
            onEvent: (event) => {
              ctx.state.appendEvent(event);
              report(event.type);
            },
          });
          
          opToken.throwIfCancelled();
          
          if (result.status === 'resolved') {
            ctx.showMessage('ResolveIt: test successful - project resolved.');
          } else {
            ctx.showWarning(`ResolveIt test finished with status ${result.status}: ${result.reason ?? 'see output'}.`);
          }
          ctx.logger.info(`Test run ${result.runId}: ${result.status} after ${result.iterations} iteration(s).`);
        });
      });
    } catch (error) {
      reportClassified(ctx, classifyError(error, 'ResolveIt test'), 'ResolveIt: test failed');
    }
    ctx.postMessage({ type: 'refresh' });
  };

  handlers['workflow.returnToPlan'] = async (): Promise<void> => {
    // Clear execution and verification to go back to repair plan
    ctx.state.clearRepairPlan();
    const plan = ctx.state.getRepairPlan();
    // Re-create the plan from current diagnostics if possible
    if (!plan && ctx.state.getHasScanned()) {
      const root = ctx.getWorkspaceRoot();
      if (root) {
        const { plan: newPlan } = await ctx.core.planRepairs(root);
        ctx.state.setRepairPlan(newPlan, newPlan.description);
      }
    }
    ctx.postMessage({ type: 'refresh' });
  };

  handlers['workflow.restart'] = async (): Promise<void> => {
    const root = ctx.getWorkspaceRoot();
    if (root) {
      ctx.state.bindWorkspace(root);
    }
    ctx.postMessage({ type: 'refresh' });
  };

  handlers['workflow.goBack'] = async (): Promise<void> => {
    // Navigate back in workflow - the model will handle this based on state
    ctx.postMessage({ type: 'navigate', direction: 'back' });
  };

  handlers['workflow.goForward'] = async (): Promise<void> => {
    // Navigate forward in workflow
    ctx.postMessage({ type: 'navigate', direction: 'forward' });
  };

  return handlers;
}

import * as vscode from 'vscode';