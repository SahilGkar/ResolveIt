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

export function createCommandHandlers(ctx: CommandContext): Record<string, () => Promise<void>> {
  const handlers: Record<string, () => Promise<void>> = {};

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
    const diagnostics = await ctx.core.diagnoseProject(root);
    if (!ensureFresh(ctx, root, token)) {
      return;
    }
    ctx.state.setDiagnostics(diagnostics);
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
    const { plan, diagnostics } = await ctx.core.planRepairs(root);
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
    ctx.logger.info(`Repair plan (${planSummary(plan)}):`);
    for (const action of plan.actions) {
      for (const line of actionLines(action)) {
        ctx.logger.info(`  ${line}`);
      }
    }
    const approved = await requestPlanApproval(plan, [], ctx.dialogs, (message) => ctx.messages.info(message));
    token.throwIfCancelled();
    if (!ctx.workspaces.isCurrent(root)) {
      ctx.logger.warn(`Workspace changed during repair approval; discarding plan for ${root}.`);
      return;
    }
    if (approved.length === 0) {
      ctx.messages.info('ResolveIt: no actions approved; nothing was executed.');
      ctx.status.showIssues(diagnostics.length, ctx.state.blockingCount());
      return;
    }
    ctx.status.showBusy('applying repairs', 'ResolveIt: applying repairs');
    const execution = await ctx.core.executeApproved(root, plan, approved);
    token.throwIfCancelled();
    if (!ctx.workspaces.isCurrent(root)) {
      ctx.logger.warn(`Workspace changed during repair execution; discarding results for ${root}.`);
      return;
    }
    const succeeded = execution.results.filter((entry) => entry.result.success);
    const failed = execution.results.filter((entry) => !entry.result.success);
    ctx.logger.info(
      `Repair: ${approved.length} approved, ${execution.results.length} executed, ${succeeded.length} succeeded, ${failed.length} failed.`
    );
    if (failed.length > 0) {
      const classified = repairFailure(failed.map((entry) => entry.result.error ?? 'unknown error').join('; '));
      ctx.messages.error(classified.userMessage);
      ctx.logger.error(classified.logDetail);
    }
    const verification = await ctx.core.verifyAgainstPrevious(root, diagnostics);
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
    } else {
      ctx.messages.info(`ResolveIt repair verified: ${verification.resolved.length} resolved, nothing remaining.`);
    }
    ctx.status.showIssues(verification.current.length, ctx.state.blockingCount());
    ctx.refreshViews();
  });

  handlers['resolveit.verify'] = guarded('verify', async (root, token) => {
    ctx.status.showBusy('verifying', 'ResolveIt: verifying');
    const previous = ctx.state.getDiagnostics();
    const verification = await ctx.core.verifyAgainstPrevious(root, previous);
    if (!ensureFresh(ctx, root, token)) {
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
          }
        });
      });
    } catch (error) {
      reportClassified(ctx, classifyError(error, 'ResolveIt run'), 'ResolveIt: run failed');
    }
  };

  return handlers;
}
