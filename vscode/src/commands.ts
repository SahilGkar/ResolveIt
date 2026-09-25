import type {
  AIConfig,
  RepairPlan,
} from '../../src/index.js';
import { actionLines, describeAgentEvent, friendlyError, multiRootNotice, planSummary } from './mappers.js';
import { primaryRoot, resolveWorkspace } from './workspace.js';
import type { FolderLike } from './workspace.js';
import type { CoreClient } from './core.js';
import type { ExtensionState } from './state.js';
import { requestPlanApproval } from './ui/approval.js';
import type { ApprovalDialogs } from './ui/approval.js';
import type { Logger } from './ui/output.js';

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

export interface CommandContext {
  readonly core: CoreClient;
  readonly state: ExtensionState;
  readonly logger: Logger;
  readonly messages: MessageSink;
  readonly status: StatusControls;
  readonly dialogs: ApprovalDialogs;
  readonly refreshViews: () => void;
  readonly getWorkspaceFolders: () => ReadonlyArray<FolderLike> | undefined;
  readonly reportProgress: <T>(title: string, task: (report: (message: string) => void) => Promise<T>) => Promise<T>;
  readonly getAIConfig: () => AIConfig;
  readonly getMaxIterations: () => number;
  readonly openFile: (absolutePath: string) => Promise<void>;
}

function requireRoot(ctx: CommandContext): string | undefined {
  const resolution = resolveWorkspace(ctx.getWorkspaceFolders());
  if (resolution.kind === 'none') {
    ctx.messages.info('ResolveIt needs an open folder. Open a folder workspace first.');
    return undefined;
  }
  if (resolution.kind === 'multi') {
    ctx.messages.warn(multiRootNotice(resolution.roots));
  }
  return primaryRoot(resolution);
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

  handlers['resolveit.scan'] = async () => {
    const root = requireRoot(ctx);
    if (!root) {
      return;
    }
    ctx.status.showBusy('scanning', 'ResolveIt: scanning workspace');
    try {
      const workspace = await ctx.core.scanProject(root);
      const first = workspace.projects[0];
      ctx.state.setProjectName(first ? first.name : '(no projects)');
      ctx.logger.info(`Scanned ${root}: ${workspace.projects.length} project(s), ${workspace.allFiles.length} file(s).`);
      ctx.status.showOk(`ResolveIt: scanned ${workspace.projects.length} project(s)`);
      ctx.refreshViews();
    } catch (error) {
      ctx.status.showOk('ResolveIt: scan failed');
      ctx.logger.error(friendlyError('ResolveIt could not scan the workspace', error));
      ctx.messages.error(friendlyError('ResolveIt could not scan the workspace', error));
    }
  };

  handlers['resolveit.diagnose'] = async () => {
    const root = requireRoot(ctx);
    if (!root) {
      return;
    }
    ctx.status.showBusy('diagnosing', 'ResolveIt: running diagnostics');
    try {
      const diagnostics = await ctx.core.diagnoseProject(root);
      ctx.state.setDiagnostics(diagnostics);
      const blocking = ctx.state.blockingCount();
      ctx.logger.info(`Diagnostics for ${root}: ${diagnostics.length} total, ${blocking} blocking.`);
      ctx.status.showIssues(diagnostics.length, blocking);
      ctx.refreshViews();
    } catch (error) {
      ctx.status.showOk('ResolveIt: diagnose failed');
      ctx.logger.error(friendlyError('ResolveIt could not run diagnostics', error));
      ctx.messages.error(friendlyError('ResolveIt could not run diagnostics', error));
    }
  };

  handlers['resolveit.environment'] = async () => {
    ctx.status.showBusy('inspecting environment', 'ResolveIt: inspecting environment');
    try {
      const root = requireRoot(ctx);
      if (root) {
        await describeEnvironment(ctx);
      } else {
        const environment = await ctx.core.environmentInfo();
        ctx.state.setEnvironment(environment);
      }
      ctx.status.showOk('ResolveIt: environment refreshed');
      ctx.refreshViews();
    } catch (error) {
      ctx.status.showOk('ResolveIt: environment check failed');
      ctx.logger.error(friendlyError('ResolveIt could not inspect the environment', error));
      ctx.messages.error(friendlyError('ResolveIt could not inspect the environment', error));
    }
  };

  handlers['resolveit.requirements'] = async () => {
    const root = requireRoot(ctx);
    if (!root) {
      return;
    }
    ctx.status.showBusy('reading requirements', 'ResolveIt: reading requirements');
    try {
      const requirements = await ctx.core.projectRequirements(root);
      ctx.state.setRequirements(requirements);
      const count = requirements.flatMap((parsed) => [...parsed.requirements]).length;
      ctx.logger.info(`Requirements for ${root}: ${count} requirement(s).`);
      ctx.status.showOk('ResolveIt: requirements refreshed');
      ctx.refreshViews();
    } catch (error) {
      ctx.status.showOk('ResolveIt: requirements check failed');
      ctx.logger.error(friendlyError('ResolveIt could not read requirements', error));
      ctx.messages.error(friendlyError('ResolveIt could not read requirements', error));
    }
  };

  handlers['resolveit.repair'] = async () => {
    const root = requireRoot(ctx);
    if (!root) {
      return;
    }
    ctx.status.showBusy('planning repairs', 'ResolveIt: planning repairs');
    try {
      const { plan, diagnostics } = await ctx.core.planRepairs(root);
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
      if (approved.length === 0) {
        ctx.messages.info('ResolveIt: no actions approved; nothing was executed.');
        ctx.status.showIssues(diagnostics.length, ctx.state.blockingCount());
        return;
      }
      ctx.status.showBusy('applying repairs', 'ResolveIt: applying repairs');
      const execution = await ctx.core.executeApproved(root, plan, approved);
      const failed = execution.results.filter((entry) => !entry.result.success);
      ctx.logger.info(`Repair execution: ${execution.results.length - failed.length} succeeded, ${failed.length} failed.`);
      const verification = await ctx.core.verifyAgainstPrevious(root, diagnostics);
      ctx.state.setLastVerification({ resolved: verification.resolved, remaining: verification.remaining, timestamp: new Date() });
      ctx.state.setDiagnostics(verification.current);
      ctx.logger.info(`Verification: ${verification.resolved.length} resolved, ${verification.remaining.length} remaining.`);
      ctx.status.showIssues(verification.current.length, ctx.state.blockingCount());
      ctx.refreshViews();
    } catch (error) {
      ctx.status.showOk('ResolveIt: repair failed');
      ctx.logger.error(friendlyError('ResolveIt repair failed', error));
      ctx.messages.error(friendlyError('ResolveIt repair failed', error));
    }
  };

  handlers['resolveit.verify'] = async () => {
    const root = requireRoot(ctx);
    if (!root) {
      return;
    }
    ctx.status.showBusy('verifying', 'ResolveIt: verifying');
    try {
      const previous = ctx.state.getDiagnostics();
      const verification = await ctx.core.verifyAgainstPrevious(root, previous);
      ctx.state.setLastVerification({ resolved: verification.resolved, remaining: verification.remaining, timestamp: new Date() });
      ctx.state.setDiagnostics(verification.current);
      ctx.messages.info(`ResolveIt verification: ${verification.resolved.length} resolved, ${verification.remaining.length} remaining.`);
      ctx.logger.info(`Verification: ${verification.resolved.length} resolved, ${verification.remaining.length} remaining.`);
      ctx.status.showIssues(verification.current.length, ctx.state.blockingCount());
      ctx.refreshViews();
    } catch (error) {
      ctx.status.showOk('ResolveIt: verification failed');
      ctx.logger.error(friendlyError('ResolveIt verification failed', error));
      ctx.messages.error(friendlyError('ResolveIt verification failed', error));
    }
  };

  handlers['resolveit.run'] = async () => {
    const root = requireRoot(ctx);
    if (!root) {
      return;
    }
    ctx.state.clearRunHistory();
    await ctx.reportProgress('ResolveIt Run', async (report) => {
      ctx.status.showBusy('running', 'ResolveIt: agent run in progress');
      try {
        const { result } = await ctx.core.runAgent({
          workspaceRoot: root,
          dryRun: false,
          aiConfig: ctx.getAIConfig(),
          maxIterations: ctx.getMaxIterations(),
          approvalCallback: (plan: RepairPlan, manual) =>
            requestPlanApproval(plan, manual, ctx.dialogs, (message) => ctx.messages.info(message)).then((ids) => [...ids]),
          onEvent: (event) => {
            ctx.state.appendEvent(event);
            report(describeAgentEvent(event.type));
            ctx.status.showBusy(describeAgentEvent(event.type).toLowerCase(), `ResolveIt: ${describeAgentEvent(event.type).toLowerCase()}`);
          },
        });
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
        ctx.state.setDiagnostics(fresh);
        ctx.refreshViews();
      } catch (error) {
        ctx.status.showOk('ResolveIt: run failed');
        ctx.logger.error(friendlyError('ResolveIt run failed', error));
        ctx.messages.error(friendlyError('ResolveIt run failed', error));
      }
    });
  };

  return handlers;
}
