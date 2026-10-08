import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';
import { __reset } from './vscode-mock.js';
import { COMMAND_IDS } from '../src/extension.js';
import { OperationCoordinator, OperationBusyError, OperationCancelledError } from '../src/operations.js';
import { classifyError, repairFailure, verificationFailure } from '../src/errors.js';
import { WorkspaceService, resolveWorkspace } from '../src/workspace.js';
import type { FolderLike } from '../src/workspace.js';
import { ExtensionState } from '../src/state.js';
import { RunEventScope } from '../src/ui/events.js';
import { CoreClient } from '../src/core.js';
import { Logger } from '../src/ui/output.js';
import { createCommandHandlers } from '../src/commands.js';
import type { CommandContext, CancellationTokenLike } from '../src/commands.js';
import type { ApprovalDialogs } from '../src/ui/approval.js';
import type { AgentEvent, Diagnostic, RepairPlan } from '../../src/index.js';
import { checkManifestParity, checkPackageHygiene } from '../scripts/validate-package.mjs';

beforeEach(() => {
  __reset();
});

function foldersOf(...roots: string[]): FolderLike[] {
  return roots.map((root, index) => ({ name: `folder-${index}`, uri: { fsPath: root } }));
}

function event(type: string, runId: string): AgentEvent {
  return { seq: 1, type: type as never, runId, timestamp: new Date(), state: 'acting' as never };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('workspace lifecycle', () => {
  it('should resolve zero, one, and two folders deterministically', () => {
    expect(resolveWorkspace(undefined).kind).toBe('none');
    const service = new WorkspaceService({ getFolders: () => [], notifyMultiRoot: () => undefined });
    expect(service.activeRoot()).toBeUndefined();

    const single = new WorkspaceService({ getFolders: () => foldersOf('/a'), notifyMultiRoot: () => undefined });
    expect(single.activeRoot()).toBe('/a');

    const notices: string[][] = [];
    let current = foldersOf('/a', '/b');
    const multi = new WorkspaceService({
      getFolders: () => current,
      notifyMultiRoot: (roots) => notices.push([...roots]),
    });
    expect(multi.activeRoot()).toBe('/a');
    expect(multi.sync().changed).toBe(true);
    expect(notices).toHaveLength(1);
    expect(multi.sync().changed).toBe(false);
    expect(notices).toHaveLength(1);
    current = foldersOf('/a', '/c');
    expect(multi.sync().changed).toBe(true);
    expect(notices).toHaveLength(2);
  });

  it('should clear stale state when the workspace switches', () => {
    const state = new ExtensionState();
    state.bindWorkspace('/a');
    state.setDiagnostics([{ id: 'd' } as Diagnostic]);
    state.setProjectName('a');
    expect(state.blockingCount()).toBe(0);

    const changed = state.bindWorkspace('/b');
    expect(changed).toBe(true);
    expect(state.getDiagnostics()).toHaveLength(0);
    expect(state.getProjectName()).toBeUndefined();
    expect(state.getWorkspaceRoot()).toBe('/b');
    expect(state.bindWorkspace('/b')).toBe(false);
  });

  it('should discard results computed for a stale workspace root', async () => {
    let folders = foldersOf('/a');
    const gate = deferred<Diagnostic[]>();
    const core = {
      diagnoseProject: () => gate.promise,
    } as unknown as CoreClient;
    const messages: string[] = [];
    const logged: string[] = [];
    const state = new ExtensionState();
    const ctx: CommandContext = {
      core,
      state,
      logger: new Logger({ appendLine: (line) => logged.push(line), show: () => undefined }),
      messages: {
        info: (message) => messages.push(`info:${message}`),
        warn: (message) => messages.push(`warn:${message}`),
        error: (message) => messages.push(`error:${message}`),
      },
      status: {
        showBusy: () => undefined,
        showIssues: () => undefined,
        showOk: () => undefined,
      },
      dialogs: { showPlanMessage: () => Promise.resolve(), askAction: () => Promise.resolve(false) },
      coordinator: new OperationCoordinator(),
      workspaces: new WorkspaceService({ getFolders: () => folders, notifyMultiRoot: () => undefined }),
      refreshViews: () => undefined,
      getWorkspaceFolders: () => folders,
      reportProgress: (_title, task) => task(() => undefined),
      reportCancellable: (_title, task) =>
        task(() => undefined, { isCancellationRequested: false, onCancellationRequested: () => undefined }),
      getAIConfig: () => ({ provider: 'none' }),
      getMaxIterations: () => 3,
      openFile: () => Promise.resolve(),
    };

    const handlers = createCommandHandlers(ctx);
    const pending = handlers['resolveit.diagnose']?.();
    folders = foldersOf('/b');
    gate.resolve([{ id: 'stale' } as Diagnostic]);
    await pending;
    expect(state.getDiagnostics()).toHaveLength(0);
    expect(logged.some((line) => line.includes('discarding results'))).toBe(true);
    expect(messages.some((message) => message.includes('Stale results were discarded'))).toBe(true);
  });
});

describe('operation coordinator', () => {
  it('should reject duplicate operations for the same workspace', async () => {
    const coordinator = new OperationCoordinator();
    const gate = deferred<string>();
    const first = coordinator.run('diagnose', '/a', () => gate.promise);
    await expect(coordinator.run('diagnose', '/a', () => Promise.resolve('second'))).rejects.toBeInstanceOf(
      OperationBusyError
    );
    gate.resolve('first');
    await expect(first).resolves.toBe('first');
    expect(coordinator.activeCount()).toBe(0);
  });

  it('should allow different operations to overlap', async () => {
    const coordinator = new OperationCoordinator();
    const gate = deferred<string>();
    const first = coordinator.run('diagnose', '/a', () => gate.promise);
    await expect(coordinator.run('scan', '/a', () => Promise.resolve('scan'))).resolves.toBe('scan');
    gate.resolve('diagnose');
    await first;
    expect(coordinator.activeCount()).toBe(0);
  });

  it('should mutually exclude runs and repairs on the same root', () => {
    const coordinator = new OperationCoordinator();
    const token = coordinator.begin('run', '/a');
    expect(() => coordinator.begin('repair', '/a')).toThrow(OperationBusyError);
    expect(() => coordinator.begin('run', '/a')).toThrow(OperationBusyError);
    coordinator.end(token);
    expect(coordinator.isActive('repair', '/a')).toBe(false);
  });

  it('should clean up after errors', async () => {
    const coordinator = new OperationCoordinator();
    await expect(
      coordinator.run('scan', '/a', () => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom');
    expect(coordinator.activeCount()).toBe(0);
    await expect(coordinator.run('scan', '/a', () => Promise.resolve('again'))).resolves.toBe('again');
  });

  it('should support cooperative cancellation', async () => {
    const coordinator = new OperationCoordinator();
    const token = coordinator.begin('verify', '/a');
    expect(token.signal.cancelled).toBe(false);
    expect(coordinator.cancel('verify', '/a')).toBe(true);
    expect(token.signal.cancelled).toBe(true);
    expect(() => token.throwIfCancelled()).toThrow(OperationCancelledError);
    expect(coordinator.cancel('verify', '/missing')).toBe(false);
    coordinator.end(token);
    expect(coordinator.activeCount()).toBe(0);
  });

  it('should surface duplicate invocations as friendly handler messages', async () => {
    const gate = deferred<Diagnostic[]>();
    const core = { diagnoseProject: () => gate.promise } as unknown as CoreClient;
    const messages: string[] = [];
    const ctx: CommandContext = {
      core,
      state: new ExtensionState(),
      logger: new Logger({ appendLine: () => undefined, show: () => undefined }),
      messages: {
        info: (message) => messages.push(message),
        warn: (message) => messages.push(message),
        error: (message) => messages.push(message),
      },
      status: { showBusy: () => undefined, showIssues: () => undefined, showOk: () => undefined },
      dialogs: { showPlanMessage: () => Promise.resolve(), askAction: () => Promise.resolve(false) },
      coordinator: new OperationCoordinator(),
      workspaces: new WorkspaceService({ getFolders: () => foldersOf('/a'), notifyMultiRoot: () => undefined }),
      refreshViews: () => undefined,
      getWorkspaceFolders: () => foldersOf('/a'),
      reportProgress: (_title, task) => task(() => undefined),
      reportCancellable: (_title, task) =>
        task(() => undefined, { isCancellationRequested: false, onCancellationRequested: () => undefined }),
      getAIConfig: () => ({ provider: 'none' }),
      getMaxIterations: () => 3,
      openFile: () => Promise.resolve(),
    };
    const handlers = createCommandHandlers(ctx);
    const first = handlers['resolveit.diagnose']?.();
    await handlers['resolveit.diagnose']?.();
    gate.resolve([]);
    await first;
    expect(messages.some((message) => message.includes('already running'))).toBe(true);
  });
});

describe('run event scopes', () => {
  it('should ignore events after close', () => {
    const seen: AgentEvent[] = [];
    const scope = new RunEventScope((event) => seen.push(event));
    scope.handle(event('observation-started', 'run-1'));
    scope.close();
    expect(scope.isClosed()).toBe(true);
    scope.handle(event('resolved', 'run-1'));
    expect(seen).toHaveLength(1);
    expect(scope.eventCount()).toBe(1);
  });

  it('should isolate stale events from previous runs', () => {
    const seen: string[] = [];
    const first = new RunEventScope((event) => seen.push(`first:${event.type}`));
    const second = new RunEventScope((event) => seen.push(`second:${event.type}`));
    first.handle(event('observation-started', 'run-1'));
    first.close();
    first.handle(event('resolved', 'run-1'));
    second.handle(event('resolved', 'run-2'));
    expect(seen).toEqual(['first:observation-started', 'second:resolved']);
  });
});

describe('error boundary', () => {
  it('should classify cancellation and busy operations', () => {
    expect(classifyError(new OperationCancelledError(), 'ResolveIt run').kind).toBe('cancelled');
    expect(classifyError(new OperationBusyError('run', '/a'), 'ResolveIt run').kind).toBe('already-running');
  });

  it('should classify invalid workspaces and permission problems', () => {
    expect(classifyError(new Error('ENOENT: no such file'), 'ResolveIt scan').kind).toBe('invalid-workspace');
    expect(classifyError(new Error('EACCES: permission denied'), 'ResolveIt scan').kind).toBe('permission-denied');
    expect(classifyError(new Error('weird failure'), 'ResolveIt scan').kind).toBe('unexpected');
  });

  it('should never leak secrets into messages or logs', () => {
    const classified = classifyError(
      new Error('request failed with apiKey: hunter2 and Bearer abc123'),
      'ResolveIt AI operation'
    );
    expect(classified.userMessage).not.toContain('hunter2');
    expect(classified.userMessage).not.toContain('abc123');
    expect(classified.logDetail).not.toContain('hunter2');
    expect(classified.logDetail).not.toContain('abc123');
  });

  it('should build repair and verification failures without stacks', () => {
    const repair = repairFailure('exit code 1');
    expect(repair.kind).toBe('repair-failed');
    expect(repair.userMessage).toContain('exit code 1');
    const verification = verificationFailure('2 remaining.');
    expect(verification.kind).toBe('verification-failed');
    expect(verification.userMessage).toContain('did not pass');
  });
});

describe('repair workflow stages', () => {
  function repairCore(plan: RepairPlan, execute: unknown, verify: unknown, calls: string[]): CoreClient {
    return {
      planDeterministicRepairs: () => {
        calls.push('plan');
        return Promise.resolve({ plan, diagnostics: [], manualActions: [] });
      },
      executeApproved: (_root: string, _plan: RepairPlan, approved: ReadonlyArray<string>) => {
        calls.push(`execute:${approved.join(',')}`);
        return Promise.resolve(execute as never);
      },
      verifyAgainstPrevious: () => {
        calls.push('verify');
        return Promise.resolve(verify as never);
      },
    } as unknown as CoreClient;
  }

  function repairContext(
    core: CoreClient,
    answers: boolean[]
  ): { ctx: CommandContext; messages: string[]; logged: string[]; calls: string[] } {
    const messages: string[] = [];
    const logged: string[] = [];
    const queue = [...answers];
    const ctx: CommandContext = {
      core,
      state: new ExtensionState(),
      logger: new Logger({ appendLine: (line) => logged.push(line), show: () => undefined }),
      messages: {
        info: (message) => messages.push(`info:${message}`),
        warn: (message) => messages.push(`warn:${message}`),
        error: (message) => messages.push(`error:${message}`),
      },
      status: { showBusy: () => undefined, showIssues: () => undefined, showOk: () => undefined },
      dialogs: {
        showPlanMessage: () => Promise.resolve(),
        askAction: () => Promise.resolve(queue.shift() ?? false),
      },
      coordinator: new OperationCoordinator(),
      workspaces: new WorkspaceService({ getFolders: () => foldersOf('/a'), notifyMultiRoot: () => undefined }),
      refreshViews: () => undefined,
      getWorkspaceFolders: () => foldersOf('/a'),
      reportProgress: (_title, task) => task(() => undefined),
      reportCancellable: (_title, task) =>
        task(() => undefined, { isCancellationRequested: false, onCancellationRequested: () => undefined }),
      getAIConfig: () => ({ provider: 'none' }),
      getMaxIterations: () => 3,
      openFile: () => Promise.resolve(),
    };
    return { ctx, messages, logged, calls: [] };
  }

  function action(id: string): never {
    return {
      id,
      type: 'install-dependency',
      permissionLevel: 'project-modification',
      description: `Install ${id}`,
      target: {},
      parameters: {},
      riskLevel: 'project-modification',
      prerequisites: [],
    } as never;
  }

  function plan(ids: string[]): RepairPlan {
    return {
      id: 'plan-1',
      name: 'Test',
      description: 'Test',
      actions: ids.map((id) => action(id)),
      requiresApproval: true,
    } as RepairPlan;
  }

  it('should distinguish approved, executed, succeeded, and verified', async () => {
    const calls: string[] = [];
    const core = repairCore(
      plan(['a']),
      { results: [{ action: action('a'), result: { success: true } }], success: true },
      { resolved: ['k1'], remaining: [], current: [] },
      calls
    );
    const { ctx, messages, logged } = repairContext(core, [true]);
    await createCommandHandlers(ctx)['resolveit.repair']?.();
    expect(calls).toEqual(['plan', 'execute:a', 'verify']);
    expect(logged.some((line) => line.includes('1 approved, 1 executed, 1 succeeded, 0 failed'))).toBe(true);
    expect(messages.some((message) => message.includes('1 resolved, nothing remaining'))).toBe(true);
  });

  it('should execute nothing when approval is denied', async () => {
    const calls: string[] = [];
    const core = repairCore(plan(['a']), { results: [], success: true }, { resolved: [], remaining: [], current: [] }, calls);
    const { ctx, messages } = repairContext(core, [false]);
    await createCommandHandlers(ctx)['resolveit.repair']?.();
    expect(calls).toEqual(['plan']);
    expect(messages.some((message) => message.includes('nothing was executed'))).toBe(true);
  });

  it('should report manual-only plans without executing', async () => {
    const calls: string[] = [];
    const core = repairCore(plan([]), { results: [], success: true }, { resolved: [], remaining: [], current: [] }, calls);
    const { ctx, messages } = repairContext(core, []);
    await createCommandHandlers(ctx)['resolveit.repair']?.();
    expect(calls).toEqual(['plan']);
    expect(messages.some((message) => message.includes('no automated repairs'))).toBe(true);
  });

  it('should report repair failures from core results, not approval', async () => {
    const calls: string[] = [];
    const core = repairCore(
      plan(['a']),
      { results: [{ action: action('a'), result: { success: false, error: 'npm exploded' } }], success: false },
      { resolved: [], remaining: ['k'], current: [] },
      calls
    );
    const { ctx, messages } = repairContext(core, [true]);
    await createCommandHandlers(ctx)['resolveit.repair']?.();
    expect(messages.some((message) => message.includes('could not complete the repair'))).toBe(true);
    expect(messages.some((message) => message.includes('did not pass'))).toBe(true);
  });
});

describe('configuration hardening', () => {
  it('should keep secrets out of contributed settings', async () => {
    const manifest = JSON.parse(
      await (await import('fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf-8')
    ) as { contributes: { configuration: { properties: Record<string, unknown> } } };
    const keys = Object.keys(manifest.contributes.configuration.properties);
    expect(keys).toEqual([
      'resolveit.ai.provider',
      'resolveit.ai.model',
      'resolveit.ai.baseUrl',
      'resolveit.ai.timeout',
      'resolveit.maxIterations',
    ]);
    expect(keys.join(' ')).not.toMatch(/apikey|secret|token|password/i);
  });
});

describe('packaging parity', () => {
  it('should match manifest commands, views, and settings to the implementation', async () => {
    const { readFile } = await import('fs/promises');
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf-8')) as {
      main: string;
      activationEvents: string[];
      contributes: {
        commands: Array<{ command: string }>;
        views?: { explorer: Array<{ id: string }> };
        configuration: { properties: Record<string, unknown> };
      };
    };
    expect(manifest.main).toBe('./dist/extension.js');
    expect(manifest.contributes.commands.map((command) => command.command).sort()).toEqual([...COMMAND_IDS].sort());
    // The workflow is a single on-demand panel: no permanent sidebar views may exist.
    expect(manifest.contributes.views).toBeUndefined();
    for (const id of COMMAND_IDS) {
      expect(manifest.activationEvents).toContain(`onCommand:${id}`);
    }
    expect(Object.keys(manifest.contributes.configuration.properties).sort()).toEqual(
      ['resolveit.ai.baseUrl', 'resolveit.ai.model', 'resolveit.ai.provider', 'resolveit.ai.timeout', 'resolveit.maxIterations'].sort()
    );
  });

  it('should flag test and source artifacts in package hygiene checks', () => {
    const problems = checkPackageHygiene([
      'dist/extension.js',
      'package.json',
      'tests/commands.test.ts',
      'src/extension.ts',
      'node_modules/uuid/package.json',
      'tests/vscode-mock.ts',
    ]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((problem) => problem.includes('tests/commands.test.ts'))).toBe(true);
    expect(problems.some((problem) => problem.includes('src/extension.ts'))).toBe(true);
    expect(problems.some((problem) => problem.includes('node_modules'))).toBe(true);
    expect(problems.some((problem) => problem.includes('vscode-mock'))).toBe(true);
    expect(checkPackageHygiene(['dist/extension.js', 'package.json', 'README.md'])).toEqual([]);
  });

  it('should detect manifest drift', () => {
    const manifest = {
      main: './dist/extension.js',
      activationEvents: [],
      contributes: { commands: [], views: { explorer: [] }, configuration: { properties: {} } },
    };
    const source = "export const COMMAND_IDS = [\n  'resolveit.scan',\n] as const;\nexport const VIEW_IDS = [\n] as const;";
    const problems = checkManifestParity(manifest, source);
    expect(problems.some((problem) => problem.includes('resolveit.scan'))).toBe(true);
  });
});

describe('cancellation behavior', () => {
  it('should discard cancelled run results without marking success', async () => {
    const gate = deferred<{ context: unknown; result: { status: string } }>();
    let triggerCancel: (() => void) | undefined;
    const token: CancellationTokenLike = {
      isCancellationRequested: false,
      onCancellationRequested: (callback) => {
        triggerCancel = () => {
          (token as { isCancellationRequested: boolean }).isCancellationRequested = true;
          callback();
        };
      },
    };
    const core = {
      runAgent: () => gate.promise,
      diagnoseProject: () => Promise.resolve([]),
    } as unknown as CoreClient;
    const messages: string[] = [];
    const state = new ExtensionState();
    const coordinator = new OperationCoordinator();
    const ctx: CommandContext = {
      core,
      state,
      logger: new Logger({ appendLine: () => undefined, show: () => undefined }),
      messages: {
        info: (message) => messages.push(`info:${message}`),
        warn: (message) => messages.push(`warn:${message}`),
        error: (message) => messages.push(`error:${message}`),
      },
      status: { showBusy: () => undefined, showIssues: () => undefined, showOk: () => undefined },
      dialogs: { showPlanMessage: () => Promise.resolve(), askAction: () => Promise.resolve(true) },
      coordinator,
      workspaces: new WorkspaceService({ getFolders: () => foldersOf('/a'), notifyMultiRoot: () => undefined }),
      refreshViews: () => undefined,
      getWorkspaceFolders: () => foldersOf('/a'),
      reportProgress: (_title, task) => task(() => undefined),
      reportCancellable: (_title, task) => task(() => undefined, token),
      getAIConfig: () => ({ provider: 'none' }),
      getMaxIterations: () => 3,
      openFile: () => Promise.resolve(),
    };
    const handlers = createCommandHandlers(ctx);
    const pending = handlers['resolveit.run']?.();
    expect(triggerCancel).toBeDefined();
    triggerCancel?.();
    gate.resolve({ context: {}, result: { status: 'resolved', runId: 'r', iterations: 1 } });
    await pending;
    expect(state.getLastRun()).toBeUndefined();
    expect(state.getEvents()).toHaveLength(0);
    expect(messages.some((message) => message.includes('cancelled'))).toBe(true);
    expect(messages.some((message) => message.includes('project resolved'))).toBe(false);
    expect(coordinator.activeCount()).toBe(0);
  });
});

describe('manual validation fixture', () => {
  it('should diagnose, deny repair, and verify a temporary fixture', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'resolveit-phase9-'));
    try {
      await fs.writeFile(
        join(workspaceRoot, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '1.0.0', engines: { node: '>=99.0.0' } }),
        'utf-8'
      );
      const core = new CoreClient();
      const diagnostics = await core.diagnoseProject(workspaceRoot);
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);

      const { plan } = await core.planRepairs(workspaceRoot);
      const execution = await core.executeApproved(workspaceRoot, plan, []);
      expect(execution.results.every((entry) => !entry.result.success)).toBe(true);
      expect(
        execution.results.every((entry) => entry.result.error === 'Action not approved')
      ).toBe(true);

      const verification = await core.verifyAgainstPrevious(workspaceRoot, diagnostics);
      expect(verification.remaining.length).toBeGreaterThan(0);
      const manifest = await fs.readFile(join(workspaceRoot, 'package.json'), 'utf-8');
      expect(JSON.parse(manifest).engines.node).toBe('>=99.0.0');
      const entries = await fs.readdir(workspaceRoot);
      expect(entries.filter((entry) => entry !== '.resolveit')).toEqual(['package.json']);
      if (entries.includes('.resolveit')) {
        const auditOnly = await fs.readdir(join(workspaceRoot, '.resolveit'));
        expect(auditOnly).toEqual(['audit']);
      }
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120000);
});
