import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';
import { __reset } from './vscode-mock.js';
import { CoreClient } from '../src/core.js';
import { ExtensionState } from '../src/state.js';
import { Logger } from '../src/ui/output.js';
import { OperationCoordinator } from '../src/operations.js';
import { WorkspaceService } from '../src/workspace.js';
import { createCommandHandlers } from '../src/commands.js';
import type { CommandContext } from '../src/commands.js';
import type { ApprovalDialogs } from '../src/ui/approval.js';
import type { FolderLike } from '../src/workspace.js';
import type { Diagnostic, EnvironmentInfo, ParsedRequirements, Workspace } from '../../src/index.js';

beforeEach(() => {
  __reset();
});

function workspace(): Workspace {
  return {
    id: 'ws-1',
    rootPath: '/tmp/ws',
    projects: [],
    environments: [],
    allFiles: [],
    allDirectories: [],
    languages: [],
    projectMarkers: [],
    configFiles: [],
    repoIndicators: [],
    errors: [],
  };
}

function environment(): EnvironmentInfo {
  return {
    os: { platform: 'linux', architecture: 'x64', hostname: 'test' },
    runtimes: [{ name: 'node', command: 'node', version: '20.0.0', available: true }],
    devTools: [],
    packageManagers: [],
    containers: {
      docker: { name: 'docker', command: 'docker', available: false },
      dockerCompose: { name: 'docker-compose', command: 'docker-compose', available: false },
      dockerRunning: false,
    },
    environmentVariables: {},
    scannedAt: new Date(),
  };
}

function requirements(versionConstraint?: string): ParsedRequirements[] {
  if (!versionConstraint) {
    return [];
  }
  return [
    {
      projectId: 'p',
      sourceFiles: ['package.json'],
      requirements: [
        {
          id: 'req-1',
          ecosystem: 'node',
          type: 'runtime-version',
          name: 'node',
          versionConstraint,
          sourceFile: 'package.json',
        },
      ],
      parseErrors: [],
    },
  ];
}

function stubCore(calls: string[], constraint?: string): CoreClient {
  const ws = workspace();
  return new CoreClient({
    scanWorkspace: ((root: string) => {
      calls.push(`scan:${root}`);
      return Promise.resolve({ ...ws, rootPath: root });
    }) as never,
    scanEnvironment: (() => {
      calls.push('environment');
      return Promise.resolve(environment());
    }) as never,
    scanRequirements: (() => {
      calls.push('requirements');
      return Promise.resolve(requirements(constraint));
    }) as never,
  });
}

interface Recorded {
  messages: Array<{ kind: string; message: string }>;
  status: string[];
  refreshes: number;
  titles: string[];
  opened: string[];
  asked: string[];
}

function fakeContext(core: CoreClient, folders: FolderLike[], answers: boolean[] = []): { ctx: CommandContext; recorded: Recorded } {
  const recorded: Recorded = { messages: [], status: [], refreshes: 0, titles: [], opened: [], asked: [] };
  const queue = [...answers];
  const dialogs: ApprovalDialogs = {
    showPlanMessage: () => Promise.resolve(),
    askAction: (description: string) => {
      recorded.asked.push(description);
      return Promise.resolve(queue.shift() ?? false);
    },
  };
  const state = new ExtensionState();
  const workspaces = new WorkspaceService({
    getFolders: () => folders,
    notifyMultiRoot: (roots) => recorded.messages.push({ kind: 'warn', message: `multi-root: ${roots.join(',')}` }),
    onWorkspaceChanged: (root) => {
      state.bindWorkspace(root);
    },
  });
  const ctx: CommandContext = {
    core,
    state,
    logger: new Logger({ appendLine: () => undefined, show: () => undefined }),
    messages: {
      info: (message) => recorded.messages.push({ kind: 'info', message }),
      warn: (message) => recorded.messages.push({ kind: 'warn', message }),
      error: (message) => recorded.messages.push({ kind: 'error', message }),
    },
    status: {
      showBusy: (activity) => recorded.status.push(`busy:${activity}`),
      showIssues: (total, blocking) => recorded.status.push(`issues:${total}/${blocking}`),
      showOk: (tooltip) => recorded.status.push(`ok:${tooltip}`),
    },
    dialogs,
    coordinator: new OperationCoordinator(),
    workspaces,
    refreshViews: () => {
      recorded.refreshes += 1;
    },
    getWorkspaceFolders: () => folders,
    reportProgress: (title, task) => {
      recorded.titles.push(title);
      return task(() => undefined);
    },
    reportCancellable: (title, task) => {
      recorded.titles.push(title);
      return task(
        () => undefined,
        { isCancellationRequested: false, onCancellationRequested: () => undefined }
      );
    },
    getAIConfig: () => ({ provider: 'none' }),
    getMaxIterations: () => 3,
    openFile: (path) => {
      recorded.opened.push(path);
      return Promise.resolve();
    },
  };
  return { ctx, recorded };
}

const FOLDERS: FolderLike[] = [{ name: 'ws', uri: { fsPath: '/tmp/ws' } }];

describe('command handlers', () => {
  it('should refuse gracefully with no workspace open', async () => {
    const calls: string[] = [];
    const { ctx, recorded } = fakeContext(stubCore(calls), []);
    const handlers = createCommandHandlers(ctx);
    for (const id of ['resolveit.scan', 'resolveit.diagnose', 'resolveit.run', 'resolveit.repair', 'resolveit.verify']) {
      await handlers[id]?.();
    }
    expect(calls).toEqual([]);
    expect(recorded.messages.filter((m) => m.message.includes('open folder'))).toHaveLength(5);
  });

  it('should scan and record the project', async () => {
    const calls: string[] = [];
    const { ctx, recorded } = fakeContext(stubCore(calls), FOLDERS);
    await createCommandHandlers(ctx)['resolveit.scan']?.();
    expect(calls).toEqual(['scan:/tmp/ws']);
    expect(ctx.state.getProjectName()).toBe('(no projects)');
    expect(recorded.refreshes).toBe(2);
  });

  it('should diagnose and update the status', async () => {
    const calls: string[] = [];
    const { ctx, recorded } = fakeContext(stubCore(calls, '>=99.0.0'), FOLDERS);
    await createCommandHandlers(ctx)['resolveit.diagnose']?.();
    expect(ctx.state.getDiagnostics().length).toBeGreaterThan(0);
    expect(recorded.status.some((s) => s.startsWith('issues:'))).toBe(true);
  });

  it('should surface friendly errors instead of crashing', async () => {
    const core = new CoreClient({
      scanWorkspace: (() => Promise.reject(new Error('Permission denied'))) as never,
    });
    const { ctx, recorded } = fakeContext(core, FOLDERS);
    await createCommandHandlers(ctx)['resolveit.scan']?.();
    expect(recorded.messages.some((m) => m.kind === 'error' && m.message.includes('Permission denied'))).toBe(true);
  });

  it('should report no automated repairs when the plan is empty', async () => {
    const calls: string[] = [];
    const { ctx, recorded } = fakeContext(stubCore(calls), FOLDERS);
    await createCommandHandlers(ctx)['resolveit.repair']?.();
    expect(recorded.messages.some((m) => m.message.includes('no automated repairs'))).toBe(true);
    expect(recorded.asked).toHaveLength(0);
  });

  it('should never execute denied repair actions', async () => {
    const calls: string[] = [];
    const { ctx, recorded } = fakeContext(stubCore(calls, '>=99.0.0'), FOLDERS, [false, false]);
    await createCommandHandlers(ctx)['resolveit.repair']?.();
    expect(recorded.asked.length).toBeGreaterThan(0);
    expect(recorded.messages.some((m) => m.message.includes('nothing was executed'))).toBe(true);
  });

  it('should verify against previous diagnostics', async () => {
    const calls: string[] = [];
    const core = stubCore(calls, '>=99.0.0');
    const { ctx, recorded } = fakeContext(core, FOLDERS);
    const before = await core.diagnoseProject('/tmp/ws');
    expect(before.length).toBeGreaterThan(0);
    ctx.state.setDiagnostics(before);
    await createCommandHandlers(ctx)['resolveit.verify']?.();
    const verification = ctx.state.getLastVerification();
    expect(verification).toBeDefined();
    expect(verification?.resolved).toHaveLength(0);
    expect(verification?.remaining.length).toBeGreaterThan(0);
    expect(recorded.messages.some((m) => m.message.includes('verification'))).toBe(true);
  });

  it('should detect multi-root workspaces and use the first folder', async () => {
    const calls: string[] = [];
    const { ctx, recorded } = fakeContext(stubCore(calls), [
      { name: 'a', uri: { fsPath: '/a' } },
      { name: 'b', uri: { fsPath: '/b' } },
    ]);
    await createCommandHandlers(ctx)['resolveit.scan']?.();
    expect(recorded.messages.some((m) => m.kind === 'warn' && m.message.includes('multi-root'))).toBe(true);
    expect(calls).toEqual(['scan:/a']);
  });

  it('should run the agent to a resolved state on an empty project', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'resolveit-vscode-run-'));
    try {
      const calls: string[] = [];
      const { ctx, recorded } = fakeContext(new CoreClient(), [{ name: 'w', uri: { fsPath: workspaceRoot } }]);
      void calls;
      await createCommandHandlers(ctx)['resolveit.run']?.();
      expect(recorded.titles).toEqual(['ResolveIt Run']);
      expect(ctx.state.getLastRun()?.status).toBe('resolved');
      expect(ctx.state.getEvents().length).toBeGreaterThan(0);
      expect(recorded.messages.some((m) => m.message.includes('resolved'))).toBe(true);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120000);

  it('should analyze the full pipeline with one primary action', async () => {
    const calls: string[] = [];
    const { ctx, recorded } = fakeContext(stubCore(calls), FOLDERS);
    await createCommandHandlers(ctx)['resolveit.analyzeProject']?.();
    expect(ctx.state.getHasScanned()).toBe(true);
    expect(calls).toEqual(['scan:/tmp/ws', 'environment', 'requirements', 'scan:/tmp/ws', 'environment', 'requirements']);
    expect(recorded.messages.some((m) => m.message.includes('healthy'))).toBe(true);
  });

  it('should generate a repair plan and store it for dashboard review', async () => {
    const calls: string[] = [];
    const { ctx, recorded } = fakeContext(stubCore(calls, '>=99.0.0'), FOLDERS);
    const handlers = createCommandHandlers(ctx);
    await handlers['resolveit.analyzeProject']?.();
    await handlers['resolveit.generateRepairPlan']?.();
    const plan = ctx.state.getRepairPlan();
    expect(plan).toBeDefined();
    expect(plan?.actions.length).toBeGreaterThan(0);
    expect(recorded.messages.some((m) => m.message.includes('Repair plan ready'))).toBe(true);
    expect(ctx.state.isPlanStale()).toBe(false);
  });

  it('should refuse to generate a plan before analysis', async () => {
    const calls: string[] = [];
    const { ctx, recorded } = fakeContext(stubCore(calls, '>=99.0.0'), FOLDERS);
    await createCommandHandlers(ctx)['resolveit.generateRepairPlan']?.();
    expect(ctx.state.getRepairPlan()).toBeUndefined();
    expect(recorded.messages.some((m) => m.message.includes('analyze the project first'))).toBe(true);
  });

  it('should record per-action approval decisions without executing', async () => {
    const calls: string[] = [];
    const { ctx, recorded } = fakeContext(stubCore(calls, '>=99.0.0'), FOLDERS);
    const handlers = createCommandHandlers(ctx);
    await handlers['resolveit.approveAction']?.('unknown-without-plan');
    expect(recorded.messages.some((m) => m.message.includes('no repair plan'))).toBe(true);
    await handlers['resolveit.analyzeProject']?.();
    await handlers['resolveit.generateRepairPlan']?.();
    const plan = ctx.state.getRepairPlan();
    expect(plan).toBeDefined();
    const [first, second] = plan?.actions ?? [];
    await handlers['resolveit.approveAction']?.(first?.id ?? 'missing');
    await handlers['resolveit.skipAction']?.(second?.id ?? 'missing');
    await handlers['resolveit.approveAction']?.('not-in-plan');
    expect(ctx.state.getApproval(first?.id ?? '').valueOf()).toBe('approved');
    expect(ctx.state.getApproval(second?.id ?? '').valueOf()).toBe('denied');
    expect(recorded.messages.some((m) => m.message.includes('not part of the current plan'))).toBe(true);
    expect(calls.filter((call) => call.startsWith('scan:'))).not.toHaveLength(0);
  });

  it('should require approvals before applying', async () => {
    const calls: string[] = [];
    const { ctx, recorded } = fakeContext(stubCore(calls, '>=99.0.0'), FOLDERS);
    const handlers = createCommandHandlers(ctx);
    await handlers['resolveit.analyzeProject']?.();
    await handlers['resolveit.generateRepairPlan']?.();
    await handlers['resolveit.applyApprovedRepairs']?.();
    expect(recorded.messages.some((m) => m.message.includes('approve at least one repair'))).toBe(true);
    expect(ctx.state.getExecution()).toBeUndefined();
  });

  it('should block applying a stale plan', async () => {
    const calls: string[] = [];
    const core = stubCore(calls, '>=99.0.0');
    let executed = 0;
    core.executeApproved = (async () => {
      executed += 1;
      return { results: [], success: true };
    }) as never;
    const { ctx, recorded } = fakeContext(core, FOLDERS);
    const handlers = createCommandHandlers(ctx);
    await handlers['resolveit.analyzeProject']?.();
    await handlers['resolveit.generateRepairPlan']?.();
    const plan = ctx.state.getRepairPlan();
    await handlers['resolveit.approveAction']?.(plan?.actions[0]?.id ?? 'missing');
    ctx.state.setDiagnostics(await core.diagnoseProject('/tmp/ws'));
    expect(ctx.state.isPlanStale()).toBe(true);
    await handlers['resolveit.applyApprovedRepairs']?.();
    expect(executed).toBe(0);
    expect(recorded.messages.some((m) => m.message.includes('fresh plan'))).toBe(true);
  });

  it('should apply approved repairs through Core and verify', async () => {
    const calls: string[] = [];
    const core = stubCore(calls, '>=99.0.0');
    const { ctx, recorded } = fakeContext(core, FOLDERS);
    const handlers = createCommandHandlers(ctx);
    await handlers['resolveit.analyzeProject']?.();
    await handlers['resolveit.generateRepairPlan']?.();
    const plan = ctx.state.getRepairPlan();
    expect(plan).toBeDefined();
    const approvedId = plan?.actions[0]?.id ?? 'missing';
    await handlers['resolveit.approveAction']?.(approvedId);
    core.executeApproved = (async (_root: string, attempt: { actions: Array<{ id: string }> }, ids: ReadonlyArray<string>) => {
      expect(ids).toEqual([approvedId]);
      const action = attempt.actions[0];
      return { results: [{ action, result: { success: true } }], success: true };
    }) as never;
    core.verifyAgainstPrevious = (async () => ({ resolved: ['a'], remaining: [], current: [] })) as never;
    await handlers['resolveit.applyApprovedRepairs']?.();
    expect(ctx.state.getExecution()?.success).toBe(true);
    expect(ctx.state.getLastVerification()?.remaining).toEqual([]);
    expect(recorded.messages.some((m) => m.message.includes('verified'))).toBe(true);
  });

  it('should surface repair failure without false success', async () => {
    const calls: string[] = [];
    const core = stubCore(calls, '>=99.0.0');
    const { ctx, recorded } = fakeContext(core, FOLDERS);
    const handlers = createCommandHandlers(ctx);
    await handlers['resolveit.analyzeProject']?.();
    await handlers['resolveit.generateRepairPlan']?.();
    const plan = ctx.state.getRepairPlan();
    await handlers['resolveit.approveAction']?.(plan?.actions[0]?.id ?? 'missing');
    core.executeApproved = (async (_root: string, attempt: { actions: Array<{ id: string }> }) => {
      const action = attempt.actions[0];
      return { results: [{ action, result: { success: false, error: 'pip failed' } }], success: false };
    }) as never;
    core.verifyAgainstPrevious = (async () => ({ resolved: [], remaining: ['still-broken'], current: [] })) as never;
    await handlers['resolveit.applyApprovedRepairs']?.();
    expect(ctx.state.getExecution()?.success).toBe(false);
    expect(ctx.state.getLastError()).toBeDefined();
    expect(recorded.messages.some((m) => m.kind === 'error' && m.message.includes('could not complete'))).toBe(true);
    expect(recorded.messages.some((m) => m.message.includes('resolved'))).toBe(false);
  });

  it('should support askAI, retryAI, review, details, and settings helpers', async () => {
    const calls: string[] = [];
    const { ctx, recorded } = fakeContext(stubCore(calls), FOLDERS);
    const handlers = createCommandHandlers(ctx);
    await handlers['resolveit.reviewProblems']?.();
    await handlers['resolveit.reviewRepairs']?.();
    await handlers['resolveit.askAI']?.();
    await handlers['resolveit.showDetails']?.();
    await handlers['resolveit.openSettings']?.();
    expect(recorded.messages.some((m) => m.message.includes('AI planning is unavailable'))).toBe(true);
    await handlers['resolveit.retryAI']?.();
    expect(ctx.state.getAIStatus()).toBeDefined();
  });

  it('should expose environment and requirement commands', async () => {
    const calls: string[] = [];
    const { ctx, recorded } = fakeContext(stubCore(calls), FOLDERS);
    const handlers = createCommandHandlers(ctx);
    await handlers['resolveit.environment']?.();
    await handlers['resolveit.requirements']?.();
    expect(ctx.state.getEnvironment()).toBeDefined();
    expect(recorded.refreshes).toBe(3);
  });
});
