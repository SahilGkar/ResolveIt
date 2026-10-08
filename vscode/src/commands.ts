import type {
  AIConfig,
  RepairPlan,
} from '../../src/index.js';
import { actionLines, describeAgentEvent, planSummary } from './mappers.js';
import type { FolderLike } from './workspace.js';
import type { CoreClient } from './core.js';
import type { ExtensionState } from './state.js';
import { classifyError, repairFailure, verificationFailure } from './errors.js';
import type { ClassifiedError } from './errors.js';
import type { OperationCoordinator } from './operations.js';
import type { OperationKind, OperationToken } from './operations.js';
import { requestPlanApproval } from './ui/approval.js';
import type { ApprovalDialogs } from './ui/approval.js';
import { RunEventScope } from './ui/events.js';
import type { Logger } from './ui/output.js';
import type { WorkspaceService } from './workspace.js';
import type { WorkflowStep } from './workflow/model.js';

export interface MessageSink {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface StatusControls {
  showBusy(activity: string, tooltip: string): void;
  showIssues(total: number, blocking: number): void;
  showOk(tooltip: string): void;
}

export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(callback: () => void): void;
}

export interface CommandContext {
  readonly core: CoreClient;
  readonly state: ExtensionState;
  readonly logger: Logger;
  readonly messages: MessageSink;
  readonly status: StatusControls;
  readonly dialogs: ApprovalDialogs;
  readonly coordinator: OperationCoordinator;
  readonly workspaces: WorkspaceService;
  readonly refreshViews: () => void;
  readonly getWorkspaceFolders: () => ReadonlyArray<FolderLike> | undefined;
  readonly reportProgress: <T>(title: string, task: (report: (message: string) => void) => Promise<T>) => Promise<T>;
  readonly reportCancellable: <T>(
    title: string,
    task: (report: (message: string) => void, token: CancellationTokenLike) => Promise<T>
  ) => Promise<T>;
  readonly getAIConfig: () => AIConfig;
  readonly getMaxIterations: () => number;
  readonly openFile: (absolutePath: string) => Promise<void>;
  /** Opens (or focuses) the single ResolveIt workflow panel, optionally at a stage. */
  readonly openWorkflow?: (step?: WorkflowStep) => void;
  readonly openSettings?: (query: string) => void;
  readonly showOutput?: () => void;
}

function requireRoot(ctx: CommandContext): string | undefined {
  const { root } = ctx.workspaces.sync();
  const bound = ctx.state.bindWorkspace(root);
  if (bound) {
    ctx.refreshViews();
  }
  if (!root) {
    ctx.messages.info('ResolveIt needs an open folder. Open a folder workspace first.');
    return undefined;
  }
  return root;
}

function ensureFresh(ctx: CommandContext, root: string, token: OperationToken): boolean {
  token.throwIfCancelled();
  if (!ctx.workspaces.isCurrent(root)) {
    ctx.logger.warn(`Workspace changed during operation; discarding results for ${root}.`);
    ctx.messages.warn('The workspace changed during the operation. Stale results were discarded.');
    return false;
  }
  return true;
}

function reportClassified(
  ctx: CommandContext,
  classified: ClassifiedError,
  statusHint: string
): void {
  if (classified.kind === 'cancelled') {
    ctx.messages.info(classified.userMessage);
    ctx.logger.info(classified.logDetail);
    ctx.status.showOk('ResolveIt: operation cancelled');
    return;
  }
  if (classified.kind === 'already-running') {
    ctx.messages.info(classified.userMessage);
    ctx.logger.info(classified.logDetail);
    return;
  }
  ctx.messages.error(classified.userMessage);
  ctx.logger.error(classified.logDetail);
  ctx.status.showOk(statusHint);
}

async function describeEnvironment(ctx: CommandContext): Promise<void> {
  const environment = await ctx.core.environmentInfo();
  ctx.state.setEnvironment(environment);
  ctx.logger.info(
    `Environment: ${environment.runtimes.length} runtimes, ${environment.devTools.length} tools, ` +
      `${environment.packageManagers.length} package managers, docker ${environment.containers.dockerRunning ? 'running' : 'not running'}.`
  );
}

export function createCommandHandlers(ctx: CommandContext): Record<string, (...args: Array<unknown>) => Promise<void>> {
  const handlers: Record<string, (...args: Array<unknown>) => Promise<void>> = {};

  const guarded = (kind: OperationKind, task: (root: string, token: OperationToken) => Promise<void>) => {
    return async (): Promise<void> => {
      const root = requireRoot(ctx);
      if (!root) {
        return;
      }
      try {
        await ctx.coordinator.run(kind, root, async (token) => task(root, token));
      } catch (error) {
        reportClassified(ctx, classifyError(error, `ResolveIt ${kind}`), `ResolveIt: ${kind} failed`);
      }
    };
  };

  handlers['resolveit.scan'] = guarded('scan', async (root, token) => {
    ctx.status.showBusy('scanning', 'ResolveIt: scanning workspace');
    const workspace = await ctx.core.scanProject(root);
    if (!ensureFresh(ctx, root, token)) {
      return;
    }
    const first = workspace.projects[0];
    ctx.state.setProjectName(first ? first.name : '(no projects)');
    ctx.logger.info(`Scanned ${root}: ${workspace.projects.length} project(s), ${workspace.allFiles.length} file(s).`);
    ctx.status.showOk(`ResolveIt: scanned ${workspace.projects.length} project(s)`);
    ctx.refreshViews();
  });

  handlers['resolveit.diagnose'] = guarded('diagnose', async (root, token) => {
    ctx.status.showBusy('diagnosing', 'ResolveIt: running diagnostics');
    ctx.state.setActiveOperation({ kind: 'diagnose', activity: 'Running diagnostics…' });
    ctx.refreshViews();
    const diagnostics = await ctx.core.diagnoseProject(root);
    if (!ensureFresh(ctx, root, token)) {
      ctx.state.setActiveOperation(undefined);
      ctx.refreshViews();
      return;
    }
    ctx.state.setActiveOperation(undefined);
    ctx.state.setDiagnostics(diagnostics);
    ctx.state.markScanned();
    ctx.state.clearLastError();
    const blocking = ctx.state.blockingCount();
    ctx.logger.info(`Diagnostics for ${root}: ${diagnostics.length} total, ${blocking} blocking.`);
    ctx.status.showIssues(diagnostics.length, blocking);
    ctx.refreshViews();
  });

  handlers['resolveit.environment'] = guarded('environment', async (root, token) => {
    ctx.status.showBusy('inspecting environment', 'ResolveIt: inspecting environment');
    await describeEnvironment(ctx);
    if (!ensureFresh(ctx, root, token)) {
      return;
    }
    ctx.status.showOk('ResolveIt: environment refreshed');
    ctx.refreshViews();
  });

  handlers['resolveit.requirements'] = guarded('requirements', async (root, token) => {
    ctx.status.showBusy('reading requirements', 'ResolveIt: reading requirements');
    const requirements = await ctx.core.projectRequirements(root);
    if (!ensureFresh(ctx, root, token)) {
      return;
    }
    ctx.state.setRequirements(requirements);
    const count = requirements.flatMap((parsed) => [...parsed.requirements]).length;
    ctx.logger.info(`Requirements for ${root}: ${count} requirement(s).`);
    ctx.status.showOk('ResolveIt: requirements refreshed');
    ctx.refreshViews();
  });

  handlers['resolveit.repair'] = guarded('repair', async (root, token) => {
    ctx.status.showBusy('planning repairs', 'ResolveIt: planning repairs');
    ctx.state.setActiveOperation({ kind: 'analyze', activity: 'Planning repairs…' });
    ctx.refreshViews();
    const { plan, diagnostics, manualActions } =
      await ctx.core.planDeterministicRepairs(root);
    token.throwIfCancelled();
    if (!ctx.workspaces.isCurrent(root)) {
      ctx.logger.warn(`Workspace changed during repair planning; discarding plan for ${root}.`);
      return;
    }
    ctx.state.setDiagnostics(diagnostics);
    if (plan.actions.length === 0) {
      ctx.messages.info('ResolveIt found no automated repairs. Manual action may be required.');
      ctx.logger.info('Repair planning produced no executable actions.');
      ctx.refreshViews();
      return;
    }
    ctx.logger.info(`Repair plan (deterministic, ${planSummary(plan)}):`);
    for (const action of plan.actions) {
      for (const line of actionLines(action)) {
        ctx.logger.info(`  ${line}`);
      }
    }
    if (manualActions.length > 0) {
      ctx.messages.info(
        `Manual action required: ${manualActions.map((manual) => manual.description).join('; ')}`
      );
    }
    const approved = await requestPlanApproval(plan, [], ctx.dialogs, (message) => ctx.messages.info(message));
    token.throwIfCancelled();
    if (!ctx.workspaces.isCurrent(root)) {
      ctx.logger.warn(`Workspace changed during repair approval; discarding plan for ${root}.`);
      ctx.state.setActiveOperation(undefined);
      ctx.refreshViews();
      return;
    }
    if (approved.length === 0) {
      ctx.messages.info('ResolveIt: no actions approved; nothing was executed.');
      ctx.status.showIssues(diagnostics.length, ctx.state.blockingCount());
      ctx.state.setActiveOperation(undefined);
      ctx.refreshViews();
      return;
    }
    ctx.status.showBusy('applying repairs', 'ResolveIt: applying repairs');
    ctx.state.setActiveOperation({ kind: 'repair', activity: 'Applying approved repairs…' });
    ctx.refreshViews();
    const execution = await ctx.core.executeApproved(root, plan, approved);
    token.throwIfCancelled();
    if (!ctx.workspaces.isCurrent(root)) {
      ctx.logger.warn(`Workspace changed during repair execution; discarding results for ${root}.`);
      ctx.state.setActiveOperation(undefined);
      ctx.refreshViews();
      return;
    }
    const approvedSet = new Set(approved);
    const succeeded = execution.results.filter(
      (entry) => approvedSet.has(entry.action.id) && entry.result.success
    );
    const failed = execution.results.filter(
      (entry) => approvedSet.has(entry.action.id) && !entry.result.success
    );
    ctx.logger.info(
      `Repair: ${approved.length} approved, ${succeeded.length + failed.length} executed, ${succeeded.length} succeeded, ${failed.length} failed.`
    );
    if (failed.length > 0) {
      const classified = repairFailure(failed.map((entry) => entry.result.error ?? 'unknown error').join('; '));
      ctx.messages.error(classified.userMessage);
      ctx.logger.error(classified.logDetail);
    }
    ctx.state.setActiveOperation({ kind: 'verify', activity: 'Verifying changes…' });
    ctx.refreshViews();
    const verification = await ctx.core.verifyAgainstPrevious(root, diagnostics);
    token.throwIfCancelled();
    if (!ctx.workspaces.isCurrent(root)) {
      ctx.logger.warn(`Workspace changed during repair verification; discarding results for ${root}.`);
      ctx.state.setActiveOperation(undefined);
      ctx.refreshViews();
      return;
    }
    ctx.state.setActiveOperation(undefined);
    ctx.state.setLastVerification({ resolved: verification.resolved, remaining: verification.remaining, timestamp: new Date() });
    ctx.state.setDiagnostics(verification.current);
    ctx.logger.info(`Verification: ${verification.resolved.length} resolved, ${verification.remaining.length} remaining.`);
    if (verification.remaining.length > 0) {
      const classified = verificationFailure(`${verification.remaining.length} blocking diagnostic(s) remain.`);
      ctx.messages.warn(classified.userMessage);
      ctx.logger.warn(classified.logDetail);
    } else {
      ctx.messages.info(`ResolveIt repair verified: ${verification.resolved.length} resolved, nothing remaining.`);
    }
    ctx.status.showIssues(verification.current.length, ctx.state.blockingCount());
    ctx.refreshViews();
  });

  handlers['resolveit.verify'] = guarded('verify', async (root, token) => {
    ctx.status.showBusy('verifying', 'ResolveIt: verifying');
    ctx.state.setActiveOperation({ kind: 'verify', activity: 'Verifying project…' });
    ctx.refreshViews();
    const previous = ctx.state.getDiagnostics();
    const verification = await ctx.core.verifyAgainstPrevious(root, previous);
    ctx.state.setActiveOperation(undefined);
    if (!ensureFresh(ctx, root, token)) {
      ctx.refreshViews();
      return;
    }
    ctx.state.setLastVerification({ resolved: verification.resolved, remaining: verification.remaining, timestamp: new Date() });
    ctx.state.setDiagnostics(verification.current);
    if (previous.length === 0) {
      ctx.messages.info(
        `ResolveIt verification: no previous diagnostics recorded; current state has ${verification.current.length} diagnostic(s), ${verification.remaining.length} blocking.`
      );
    } else if (verification.remaining.length > 0) {
      ctx.messages.warn(
        `ResolveIt verification: ${verification.resolved.length} resolved, ${verification.remaining.length} remaining.`
      );
    } else {
      ctx.messages.info(`ResolveIt verification: ${verification.resolved.length} resolved, nothing remaining.`);
    }
    ctx.logger.info(`Verification: ${verification.resolved.length} resolved, ${verification.remaining.length} remaining.`);
    ctx.status.showIssues(verification.current.length, ctx.state.blockingCount());
    ctx.refreshViews();
  });

  handlers['resolveit.run'] = async () => {
    const root = requireRoot(ctx);
    if (!root) {
      return;
    }
    try {
      await ctx.coordinator.run('run', root, async (token) => {
        ctx.state.clearRunHistory();
        ctx.state.setActiveOperation({ kind: 'run', activity: 'Running ResolveIt agent…' });
        ctx.refreshViews();
        await ctx.reportCancellable('ResolveIt Run', async (report, cancelToken) => {
          cancelToken.onCancellationRequested(() => {
            ctx.coordinator.cancel('run', root);
          });
          const scope = new RunEventScope((event) => {
            ctx.state.appendEvent(event);
            report(describeAgentEvent(event.type));
            ctx.status.showBusy(
              describeAgentEvent(event.type).toLowerCase(),
              `ResolveIt: ${describeAgentEvent(event.type).toLowerCase()}`
            );
          });
          try {
            ctx.status.showBusy('running', 'ResolveIt: agent run in progress');
            const { result } = await ctx.core.runAgent({
              workspaceRoot: root,
              dryRun: false,
              aiConfig: ctx.getAIConfig(),
              maxIterations: ctx.getMaxIterations(),
              approvalCallback: (plan: RepairPlan, manual) =>
                requestPlanApproval(plan, manual, ctx.dialogs, (message) => ctx.messages.info(message)).then((ids) => [...ids]),
              onEvent: scope.handle,
            });
            token.throwIfCancelled();
            if (cancelToken.isCancellationRequested) {
              token.throwIfCancelled();
            }
            if (!ctx.workspaces.isCurrent(root)) {
              ctx.logger.warn(`Workspace changed during agent run; discarding results for ${root}.`);
              return;
            }
            ctx.state.setLastRun({ status: result.status, timestamp: new Date(), summary: result.reason ?? '' });
            if (result.status === 'resolved') {
              ctx.messages.info('ResolveIt: project resolved.');
              ctx.status.showOk('ResolveIt: resolved');
            } else {
              ctx.messages.warn(`ResolveIt run finished with status ${result.status}: ${result.reason ?? 'see output'}.`);
              ctx.status.showOk(`ResolveIt: run ${result.status}`);
            }
            ctx.logger.info(`Agent run ${result.runId}: ${result.status} after ${result.iterations} iteration(s).`);
            const fresh = await ctx.core.diagnoseProject(root);
            token.throwIfCancelled();
            if (!ctx.workspaces.isCurrent(root)) {
              ctx.logger.warn(`Workspace changed after agent run; discarding refresh for ${root}.`);
              return;
            }
            ctx.state.setDiagnostics(fresh);
            ctx.refreshViews();
          } finally {
            scope.close();
            ctx.state.setActiveOperation(undefined);
            ctx.refreshViews();
          }
        });
      });
    } catch (error) {
      reportClassified(ctx, classifyError(error, 'ResolveIt run'), 'ResolveIt: run failed');
    }
  };

  handlers['resolveit.analyzeProject'] = guarded('analyze', async (root, token) => {
    ctx.state.clearLastError();
    const phase = (activity: string): void => {
      ctx.state.setActiveOperation({ kind: 'analyze', activity });
      ctx.status.showBusy(activity.toLowerCase().replace(/…$/, ''), `ResolveIt: ${activity.toLowerCase()}`);
      ctx.refreshViews();
    };
    try {
      phase('Discovering project…');
      const workspace = await ctx.core.scanProject(root);
      if (!ensureFresh(ctx, root, token)) {
        return;
      }
      const first = workspace.projects[0];
      ctx.state.setProjectName(first ? first.name : '(no projects)');
      phase('Checking environment…');
      await describeEnvironment(ctx);
      token.throwIfCancelled();
      if (!ensureFresh(ctx, root, token)) {
        return;
      }
      phase('Reading requirements…');
      const requirements = await ctx.core.projectRequirements(root);
      token.throwIfCancelled();
      if (!ensureFresh(ctx, root, token)) {
        return;
      }
      ctx.state.setRequirements(requirements);
      phase('Running diagnostics…');
      const diagnostics = await ctx.core.diagnoseProject(root);
      if (!ensureFresh(ctx, root, token)) {
        return;
      }
      ctx.state.setDiagnostics(diagnostics);
      ctx.state.markScanned();
      const blocking = ctx.state.blockingCount();
      ctx.logger.info(
        `Analyze ${root}: ${workspace.projects.length} project(s), ${diagnostics.length} diagnostic(s), ${blocking} blocking.`
      );
      if (blocking === 0) {
        ctx.messages.info('ResolveIt: project looks healthy. No blocking diagnostics found.');
      } else {
        ctx.messages.info(`ResolveIt: found ${blocking} blocking issue${blocking === 1 ? '' : 's'}. Review them in the ResolveIt workflow.`);
      }
      ctx.status.showIssues(diagnostics.length, blocking);
    } finally {
      ctx.state.setActiveOperation(undefined);
      ctx.refreshViews();
    }
  });

  handlers['resolveit.generateRepairPlan'] = guarded('repair', async (root, token) => {
    if (!ctx.state.getHasScanned()) {
      ctx.messages.info('ResolveIt: analyze the project first, then generate a repair plan.');
      // Still surface the workflow so the user can analyze from there.
      ctx.openWorkflow?.('analyze');
      return;
    }
    ctx.state.clearLastError();
    ctx.state.setActiveOperation({ kind: 'analyze', activity: 'Generating repair plan…' });
    ctx.status.showBusy('planning repairs', 'ResolveIt: generating repair plan');
    ctx.refreshViews();
    try {
      const { plan, diagnostics, manualActions } =
        await ctx.core.planDeterministicRepairs(root);
      token.throwIfCancelled();
      if (!ctx.workspaces.isCurrent(root)) {
        ctx.logger.warn(`Workspace changed during repair planning; discarding plan for ${root}.`);
        return;
      }
      ctx.state.setDiagnostics(diagnostics);
      ctx.state.markScanned();
      if (plan.actions.length === 0) {
        ctx.state.clearRepairPlan();
        ctx.messages.info('ResolveIt found no automated repairs. Manual action may be required.');
        ctx.logger.info('Repair planning produced no executable actions.');
        ctx.status.showIssues(diagnostics.length, ctx.state.blockingCount());
        ctx.openWorkflow?.('status');
        return;
      }
      ctx.state.setRepairPlan(plan, plan.description);
      ctx.logger.info(`Repair plan (deterministic, ${planSummary(plan)}): ${plan.description}`);
      for (const action of plan.actions) {
        for (const line of actionLines(action)) {
          ctx.logger.info(`  ${line}`);
        }
      }
      if (manualActions.length > 0) {
        ctx.messages.info(
          `Manual action required: ${manualActions.map((manual) => manual.description).join('; ')}`
        );
      }
      ctx.messages.info(
        `Repair plan ready: ResolveIt wants to make ${plan.actions.length} change${plan.actions.length === 1 ? '' : 's'}. Review each change before anything is modified.`
      );
      ctx.openWorkflow?.('repair-plan');
    } finally {
      ctx.state.setActiveOperation(undefined);
      ctx.refreshViews();
    }
  });

  const recordDecision = (approved: boolean) => {
    return async (...args: Array<unknown>): Promise<void> => {
      const actionId = typeof args[0] === 'string' ? args[0] : undefined;
      const plan = ctx.state.getRepairPlan();
      if (!plan) {
        ctx.messages.info('ResolveIt: no repair plan available. Generate a repair plan first.');
        return;
      }
      if (!actionId) {
        ctx.messages.info('ResolveIt: open the ResolveIt workflow to review each proposed repair.');
        ctx.openWorkflow?.('repair-plan');
        return;
      }
      if (!plan.actions.some((action) => action.id === actionId)) {
        ctx.messages.warn('ResolveIt: that repair action is not part of the current plan. Stale decisions were ignored.');
        ctx.logger.warn(`Approval request for unknown action ${actionId}; ignoring.`);
        return;
      }
      ctx.state.setApproval(actionId, approved);
      ctx.state.clearLastError();
      ctx.logger.info(`Repair action ${actionId}: ${approved ? 'approved' : 'skipped'} by user.`);
      ctx.refreshViews();
    };
  };

  handlers['resolveit.approveAction'] = recordDecision(true);
  handlers['resolveit.skipAction'] = recordDecision(false);

  handlers['resolveit.applyApprovedRepairs'] = guarded('repair', async (root, token) => {
    const plan = ctx.state.getRepairPlan();
    if (!plan) {
      ctx.messages.info('ResolveIt: no repair plan available. Generate a repair plan first.');
      ctx.openWorkflow?.('status');
      return;
    }
    if (ctx.state.isPlanStale()) {
      ctx.messages.warn('ResolveIt: diagnostics changed since this plan was created. Generate a fresh plan before applying.');
      ctx.logger.warn('Apply blocked: repair plan is stale relative to current diagnostics.');
      ctx.openWorkflow?.('repair-plan');
      return;
    }
    const approved = ctx.state.getApprovedIds();
    if (approved.length === 0) {
      ctx.messages.info('ResolveIt: approve at least one repair (Allow) before applying. Nothing was executed.');
      ctx.openWorkflow?.('repair-plan');
      return;
    }
    // The executor records a decision for every action in the plan. Actions the
    // user did not approve come back as "Action not approved", which is a
    // decision, not a failure, and must never be reported as one.
    const approvedSet = new Set(approved);
    ctx.state.clearLastError();
    const before = ctx.state.getDiagnostics();
    try {
      ctx.state.setActiveOperation({ kind: 'repair', activity: 'Applying approved repairs…' });
      ctx.status.showBusy('applying repairs', 'ResolveIt: applying approved repairs');
      ctx.refreshViews();
      const execution = await ctx.core.executeApproved(root, plan, approved);
      token.throwIfCancelled();
      if (!ctx.workspaces.isCurrent(root)) {
        ctx.logger.warn(`Workspace changed during repair execution; discarding results for ${root}.`);
        return;
      }
      ctx.state.setExecution({
        results: execution.results.filter((entry) => approvedSet.has(entry.action.id)),
        success: execution.results
          .filter((entry) => approvedSet.has(entry.action.id))
          .every((entry) => entry.result.success),
        timestamp: new Date(),
      });
      const failed = execution.results.filter(
        (entry) => approvedSet.has(entry.action.id) && !entry.result.success
      );
      const succeeded = execution.results.filter(
        (entry) => approvedSet.has(entry.action.id) && entry.result.success
      );
      ctx.logger.info(`Apply: ${approved.length} approved, ${succeeded.length} succeeded, ${failed.length} failed.`);
      if (failed.length > 0) {
        const classified = repairFailure(failed.map((entry) => entry.result.error ?? 'unknown error').join('; '));
        ctx.messages.error(classified.userMessage);
        ctx.logger.error(classified.logDetail);
        ctx.state.setLastError(classified.userMessage);
      }
      ctx.state.setActiveOperation({ kind: 'verify', activity: 'Verifying changes…' });
      ctx.status.showBusy('verifying', 'ResolveIt: verifying repairs');
      ctx.refreshViews();
      const verification = await ctx.core.verifyAgainstPrevious(root, before);
      token.throwIfCancelled();
      if (!ctx.workspaces.isCurrent(root)) {
        ctx.logger.warn(`Workspace changed during repair verification; discarding results for ${root}.`);
        return;
      }
      ctx.state.setLastVerification({ resolved: verification.resolved, remaining: verification.remaining, timestamp: new Date() });
      ctx.state.setDiagnostics(verification.current);
      ctx.logger.info(`Verification: ${verification.resolved.length} resolved, ${verification.remaining.length} remaining.`);
      if (verification.remaining.length > 0) {
        const classified = verificationFailure(`${verification.remaining.length} blocking diagnostic(s) remain.`);
        ctx.messages.warn(classified.userMessage);
        ctx.logger.warn(classified.logDetail);
      } else if (failed.length === 0) {
        ctx.messages.info(`ResolveIt repair verified: ${verification.resolved.length} resolved, nothing remaining.`);
      }
      ctx.status.showIssues(verification.current.length, ctx.state.blockingCount());
    } finally {
      ctx.state.setActiveOperation(undefined);
      ctx.refreshViews();
    }
  });

  handlers['resolveit.reviewProblems'] = async (): Promise<void> => {
    if (ctx.openWorkflow) {
      ctx.openWorkflow('status');
      return;
    }
    ctx.messages.info('ResolveIt: open the ResolveIt workflow to review each problem.');
  };

  handlers['resolveit.reviewRepairs'] = async (): Promise<void> => {
    if (ctx.openWorkflow) {
      ctx.openWorkflow('repair-plan');
      return;
    }
    const plan = ctx.state.getRepairPlan();
    ctx.messages.info(
      plan ? `ResolveIt: ${plan.actions.length} proposed change(s) await review.` : 'ResolveIt: no repair plan available yet.'
    );
  };

  handlers['resolveit.askAI'] = async (): Promise<void> => {
    const ai = ctx.state.getAIStatus();
    if (ai && ai.available) {
      await handlers['resolveit.generateRepairPlan']?.();
      return;
    }
    ctx.messages.info(
      'ResolveIt: AI explanations are unavailable. The deterministic repair plan still works — review the problems found.'
    );
    ctx.openWorkflow?.('ai-mode');
  };

  handlers['resolveit.retryAI'] = async (): Promise<void> => {
    const root = requireRoot(ctx);
    if (!root) {
      return;
    }
    try {
      await ctx.coordinator.run('environment', root, async (token) => {
        token.throwIfCancelled();
        const status = await ctx.core.aiStatus(ctx.getAIConfig());
        if (!ctx.workspaces.isCurrent(root)) {
          return;
        }
        ctx.state.setAIStatus({ provider: status.provider, model: status.model, baseUrl: status.baseUrl, available: status.available });
        ctx.refreshViews();
        if (status.available) {
          ctx.messages.info(`ResolveIt: AI available (${status.provider} · ${status.model}).`);
        } else {
          ctx.messages.warn('ResolveIt: AI is still unavailable. Deterministic diagnostics remain usable.');
        }
        ctx.logger.info(`AI provider: ${status.provider} (${status.available ? 'available' : 'unavailable'}).`);
      });
    } catch (error) {
      reportClassified(ctx, classifyError(error, 'ResolveIt AI retry'), 'ResolveIt: AI retry failed');
    }
  };

  handlers['resolveit.showDetails'] = async (): Promise<void> => {
    if (ctx.showOutput) {
      ctx.showOutput();
      return;
    }
    ctx.messages.info('ResolveIt: detailed logs are available in the ResolveIt output channel.');
  };

  handlers['resolveit.openSettings'] = async (): Promise<void> => {
    if (ctx.openSettings) {
      ctx.openSettings('resolveit.ai');
      return;
    }
    ctx.messages.info('ResolveIt: adjust the resolveit.ai.* settings to configure AI explanations.');
  };

  return handlers;
}
