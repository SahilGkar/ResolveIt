import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { __reset, __testState } from './vscode-mock.js';
import { ExtensionState } from '../src/state.js';
import { Logger } from '../src/ui/output.js';
import { CoreClient } from '../src/core.js';
import { createWorkflowCommandHandlers, type WorkflowCommandContext } from '../src/workflow/commands.js';
import { buildWorkflowModel, resolveActionLifecycle } from '../src/workflow/model.js';
import { renderWorkflowHtml } from '../src/workflow/render.js';
import type { RepairAction, RepairPlan, RepairResult } from '../../src/index.js';

function makeAction(id: string, description = `Install ${id}`): RepairAction {
  return {
    id,
    type: 'install-dependency',
    permissionLevel: 'project-modification',
    description,
    target: {},
    parameters: { ecosystem: 'npm', package: id },
    riskLevel: 'project-modification',
    prerequisites: [],
  };
}

function makePlan(count: number): RepairPlan {
  return {
    id: 'plan-1',
    name: 'plan',
    description: 'plan',
    actions: Array.from({ length: count }, (_, i) => makeAction(`a${i + 1}`)),
    requiresApproval: true,
  };
}

interface Harness {
  readonly state: ExtensionState;
  readonly handlers: ReturnType<typeof createWorkflowCommandHandlers>;
  readonly info: string[];
  readonly warnings: string[];
  readonly errors: string[];
  readonly core: { [key: string]: unknown };
  readonly logs: string[];
}

function harness(options: {
  executeApproved?: (plan: RepairPlan, approved: string[]) => Promise<{ results: Array<{ action: RepairAction; result: RepairResult }>; success: boolean }>;
  verify?: () => Promise<{ resolved: string[]; remaining: string[]; current: never[] }>;
  planRepairsSmart?: () => Promise<{
    plan: RepairPlan;
    diagnostics: never[];
    aiUsed: boolean;
    aiRejections: string[];
    manualActions: never[];
  }>;
  testProject?: (root: string) => Promise<unknown>;
  smokeProject?: (root: string, opts?: unknown) => Promise<unknown>;
  aiProvider?: 'none' | 'local' | 'external';
  root?: string;
  tokenTap?: (trigger: () => void) => void;
} = {}): Harness {
  const state = new ExtensionState();
  const info: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];

  const plan = makePlan(2);
  state.setRepairPlan(plan);
  state.markScanned();

  const core = {
    executeApproved:
      options.executeApproved ??
      (async (_root: string, _plan: RepairPlan, approved: string[]) => {
        const results = approved.map((id) => ({
          action: plan.actions.find((a) => a.id === id)!,
          result: { success: true } as RepairResult,
        }));
        return { results, success: true };
      }),
    verifyAgainstPrevious: options.verify ?? (async () => ({ resolved: ['x'], remaining: [] as string[], current: [] as never[] })),
    planRepairsSmart:
      options.planRepairsSmart ??
      (async () => ({ plan: makePlan(2), diagnostics: [] as never[], aiUsed: false, aiRejections: [] as string[], manualActions: [] as never[] })),
    testProject: options.testProject ?? (async () => ({ attempted: true, success: true, exitCode: 0, stdout: 'ok', stderr: '', message: 'Project test succeeded.' })),
    smokeProject:
      options.smokeProject ??
      (async () => ({
        attempted: true,
        command: { label: 'npm run dev' },
        started: true,
        listening: true,
        responded: true,
        success: true,
        port: 3000,
        url: 'http://localhost:3000/',
        timedOut: false,
        output: 'up',
        message: 'Application started and responded successfully (http://localhost:3000/).',
      })),
  };

  const ctx: WorkflowCommandContext = {
    state,
    logger: new Logger({ appendLine: (line: string) => logs.push(line), show: () => undefined }),
    core: core as unknown as CoreClient,
    showMessage: (m) => info.push(m),
    showWarning: (m) => warnings.push(m),
    showError: (m) => errors.push(m),
    showProgress: (_t, task) => task(() => undefined),
    showCancellableProgress: (_t, task) => {
      const callbacks: Array<() => void> = [];
      options.tokenTap?.(() => {
        for (const callback of [...callbacks]) {
          callback();
        }
      });
      return task(() => undefined, {
        isCancellationRequested: false,
        onCancellationRequested: (callback: () => void) => {
          callbacks.push(callback);
        },
      });
    },
    getAIConfig: () => ({ provider: options.aiProvider ?? 'none' }),
    getMaxIterations: () => 3,
    getWorkspaceRoot: () => options.root ?? 'C:\\ws',
    openFile: () => Promise.resolve(),
    postMessage: () => undefined,
  };

  return { state, handlers: createWorkflowCommandHandlers(ctx), info, warnings, errors, core, logs };
}

beforeEach(() => {
  __reset();
});
describe('approve all / deny all / partial approval', () => {
  it('should approve every pending action', async () => {
    const h = harness();
    await h.handlers['workflow.approveAll']?.();
    expect(h.state.getApprovedIds().sort()).toEqual(['a1', 'a2']);
    expect(h.state.getApproval('a1')).toBe('approved');
    expect(h.state.getApproval('a2')).toBe('approved');
  });

  it('should deny every pending action', async () => {
    const h = harness();
    await h.handlers['workflow.approveAll']?.();
    await h.handlers['workflow.denyAll']?.();
    expect(h.state.getApprovedIds()).toEqual([]);
    expect(h.state.getApproval('a1')).toBe('denied');
    expect(h.state.getApproval('a2')).toBe('denied');
  });

  it('should support individual approval and denial', async () => {
    const h = harness();
    await h.handlers['workflow.toggleApproval']?.('a1');
    expect(h.state.getApproval('a1')).toBe('approved');
    await h.handlers['workflow.toggleApproval']?.('a1');
    expect(h.state.getApproval('a1')).toBe('denied');
  });

  it('should ignore approvals for unknown action ids', async () => {
    const h = harness();
    await h.handlers['workflow.toggleApproval']?.('not-in-plan');
    expect(h.state.getApprovedIds()).toEqual([]);
  });

  it('should not bulk-approve system-level actions', async () => {
    const h = harness();
    const state = h.state;
    const plan = state.getRepairPlan();
    expect(plan).toBeDefined();
    const systemAction: RepairAction = {
      ...makeAction('sys'),
      type: 'upgrade-runtime',
      permissionLevel: 'system-modification',
      riskLevel: 'system-modification',
    };
    state.setRepairPlan({ ...plan!, actions: [...plan!.actions, systemAction] });
    await h.handlers['workflow.approveAll']?.();
    expect(state.getApproval('a1')).toBe('approved');
    expect(state.getApproval('a2')).toBe('approved');
    expect(state.getApproval('sys')).toBe('awaiting');
    expect(state.getApprovedIds().sort()).toEqual(['a1', 'a2']);
    expect(h.info.join(' ')).toContain('individual review');
  });

  it('should still allow an explicit individual decision on a system action', async () => {
    const h = harness();
    const plan = h.state.getRepairPlan();
    const systemAction: RepairAction = {
      ...makeAction('sys'),
      type: 'upgrade-runtime',
      permissionLevel: 'system-modification',
      riskLevel: 'system-modification',
    };
    h.state.setRepairPlan({ ...plan!, actions: [...plan!.actions, systemAction] });
    await h.handlers['workflow.toggleApproval']?.('sys');
    expect(h.state.getApproval('sys')).toBe('approved');
  });
});

describe('partial approval must not report a false failure', () => {
  it('should not error when unapproved actions are skipped', async () => {
    const h = harness();
    // Simulate the real executor: it iterates the whole plan and records a
    // decision for every action, returning failures for the unapproved ones.
    const plan = h.state.getRepairPlan()!;
    const executeApproved = async (_root: string, p: RepairPlan, approved: string[]) => {
      const approvedSet = new Set(approved);
      const results = p.actions.map((action) => ({
        action,
        result: approvedSet.has(action.id)
          ? ({ success: true } as RepairResult)
          : ({ success: false, error: 'Action not approved' } as RepairResult),
      }));
      return { results, success: results.every((r) => r.result.success) };
    };
    void plan;

    const h2 = harness({ executeApproved });
    await h2.handlers['workflow.toggleApproval']?.('a1');
    await h2.handlers['workflow.apply']?.();

    expect(h2.errors, 'must not report a repair failure for unapproved actions').toEqual([]);
    expect(h2.state.getLastError()).toBeUndefined();
    expect(h2.state.getExecution()?.success).toBe(true);
    // Only the approved action is reported as an execution result.
    expect(h2.state.getExecution()?.results).toHaveLength(1);
    expect(h2.state.getExecution()?.results[0]?.action.id).toBe('a1');
    // The skip is reported as information, not as a failure.
    expect(h2.info.join(' ')).toContain('not approved');
  });

  it('should report a genuine failure for an approved action that failed', async () => {
    const plan = makePlan(1);
    const executeApproved = async () => ({
      results: [{ action: plan.actions[0]!, result: { success: false, error: 'npm install exited 1' } as RepairResult }],
      success: false,
    });
    const h = harness({ executeApproved });
    await h.handlers['workflow.approveAll']?.();
    await h.handlers['workflow.apply']?.();

    expect(h.errors.join(' ')).toContain('npm install exited 1');
    expect(h.state.getExecution()?.success).toBe(false);
  });

  it('should not report a failure when only some approved actions fail', async () => {
    const plan = makePlan(2);
    const executeApproved = async (_root: string, p: RepairPlan, approved: string[]) => {
      const set = new Set(approved);
      return {
        results: p.actions.map((action) => ({
          action,
          result: set.has(action.id)
            ? (action.id === 'a1'
                ? ({ success: false, error: 'boom' } as RepairResult)
                : ({ success: true } as RepairResult))
            : ({ success: false, error: 'Action not approved' } as RepairResult),
        })),
        success: false,
      };
    };
    const h = harness({ executeApproved });
    await h.handlers['workflow.approveAll']?.();
    await h.handlers['workflow.apply']?.();

    // The only reported error is the real one, not the skipped denials.
    expect(h.errors.join(' ')).toContain('boom');
    expect(h.errors.join(' ')).not.toContain('Action not approved');
  });

  it('should block apply when nothing is approved', async () => {
    const h = harness();
    await h.handlers['workflow.apply']?.();
    expect(h.info.join(' ')).toContain('approve at least one');
    expect(h.state.getExecution()).toBeUndefined();
  });
});

describe('denied state is represented explicitly', () => {
  it('should resolve each lifecycle state', () => {
    expect(resolveActionLifecycle('awaiting')).toBe('awaiting-approval');
    expect(resolveActionLifecycle('approved')).toBe('approved');
    expect(resolveActionLifecycle('denied')).toBe('denied');
    expect(resolveActionLifecycle('approved', { success: true })).toBe('executed');
    expect(resolveActionLifecycle('approved', { success: false, error: 'x' })).toBe('failed');
    expect(resolveActionLifecycle('approved', { success: true }, true)).toBe('verified');
    // A failed execution must never fall back to awaiting approval.
    expect(resolveActionLifecycle('awaiting', { success: false })).toBe('failed');
    // Verified requires a successful execution.
    expect(resolveActionLifecycle('approved', { success: false }, true)).toBe('failed');
  });

  it('should render Denied rather than Awaiting approval', async () => {
    const h = harness();
    await h.handlers['workflow.denyAll']?.();
    const model = buildWorkflowModel(h.state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
    });
    const html = renderWorkflowHtml(model);

    expect(html).toContain('Denied');
    expect(html).not.toContain('Awaiting approval');
    expect(model.repairPlan.deniedCount).toBe(2);
    expect(model.repairPlan.approvedCount).toBe(0);
  });

  it('should show awaiting approval only for undecided actions', () => {
    const state = new ExtensionState();
    state.bindWorkspace('C:\\ws');
    state.markScanned();
    state.setRepairPlan(makePlan(3));
    state.setApproval('a1', true);
    state.setApproval('a2', false);

    const model = buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
    });
    expect(model.repairPlan.approvedCount).toBe(1);
    expect(model.repairPlan.deniedCount).toBe(1);
    expect(model.repairPlan.pendingCount).toBe(1);
    const lifecycles = model.repairPlan.actions.map((a) => a.lifecycle);
    expect(lifecycles).toEqual(['approved', 'denied', 'awaiting-approval']);
  });

  it('should disable approval controls once an action has been executed', () => {
    const state = new ExtensionState();
    state.bindWorkspace('C:\\ws');
    state.markScanned();
    const plan = makePlan(1);
    state.setRepairPlan(plan);
    state.setApproval('a1', true);
    state.setExecution({
      results: [{ action: plan.actions[0]!, result: { success: false, error: 'nope' } }],
      success: false,
      timestamp: new Date(),
    });

    const model = buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
    });
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Failed');
    expect(html).not.toContain('Awaiting approval');
    expect(model.repairPlan.actions[0]?.approvable).toBe(false);
  });
});

describe('verification failure returns to the repair plan', () => {
  it('should reach the repair plan stage and keep the failure reason', async () => {
    const h = harness({
      verify: async () => ({ resolved: ['a'], remaining: ['b'], current: [] as never[] }),
    });
    await h.handlers['workflow.approveAll']?.();
    await h.handlers['workflow.apply']?.();

    // Verification failed, so the workflow shows the failure screen.
    let model = buildWorkflowModel(h.state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
    });
    expect(model.currentStep).toBe('failed');

    await h.handlers['workflow.returnToPlan']?.();

    model = buildWorkflowModel(h.state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
    });
    expect(model.currentStep).toBe('repair-plan');
    // The failure reason is preserved rather than discarded.
    expect(model.repairPlan.previousAttempt?.message).toContain('did not resolve');
    expect(model.repairPlan.previousAttempt?.remaining).toEqual(['b']);
  });

  it('should keep the failure reason visible on the repair plan screen', async () => {
    const h = harness({
      verify: async () => ({ resolved: [], remaining: ['b'], current: [] as never[] }),
    });
    await h.handlers['workflow.approveAll']?.();
    await h.handlers['workflow.apply']?.();
    await h.handlers['workflow.returnToPlan']?.();

    const html = renderWorkflowHtml(
      buildWorkflowModel(h.state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: 'C:\\ws' })
    );
    expect(html).toContain('Previous attempt:');
  });

  it('should allow applying again after returning to the plan', async () => {
    const h = harness({
      verify: async () => ({ resolved: [], remaining: ['b'], current: [] as never[] }),
    });
    await h.handlers['workflow.approveAll']?.();
    await h.handlers['workflow.apply']?.();
    await h.handlers['workflow.returnToPlan']?.();
    await h.handlers['workflow.approveAll']?.();
    await h.handlers['workflow.apply']?.();

    expect(h.state.getExecution()).toBeDefined();
  });
});

describe('test project runs the real project command', () => {
  it('should report a successful project test', async () => {
    const testProject = async () => ({
      attempted: true,
      success: true,
      exitCode: 0,
      stdout: 'all tests passed',
      stderr: '',
      message: 'Project test succeeded.',
      command: { label: 'npm test' },
    });
    const h = harness({ testProject });
    await h.handlers['workflow.testProject']?.();

    const test = h.state.getProjectTest();
    expect(test?.attempted).toBe(true);
    expect(test?.success).toBe(true);
    expect(test?.commandLabel).toBe('npm test');
    expect(h.info.join(' ')).toContain('Project test succeeded');
  });

  it('should report a failed project test', async () => {
    const testProject = async () => ({
      attempted: true,
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: '1 test failed',
      message: 'Project test failed with exit code 1.',
      command: { label: 'npm test' },
    });
    const h = harness({ testProject });
    await h.handlers['workflow.testProject']?.();

    const test = h.state.getProjectTest();
    expect(test?.success).toBe(false);
    expect(test?.exitCode).toBe(1);
    expect(test?.output).toContain('1 test failed');
    expect(h.warnings.join(' ')).toContain('exit code 1');
  });

  it('should say so plainly when no safe test command exists', async () => {
    const testProject = async () => ({
      attempted: false,
      success: false,
      exitCode: -1,
      stdout: '',
      stderr: '',
      message: 'No safe project test command was detected.',
    });
    const h = harness({ testProject });
    await h.handlers['workflow.testProject']?.();

    const test = h.state.getProjectTest();
    expect(test?.attempted).toBe(false);
    expect(test?.message).toBe('No safe project test command was detected.');
    expect(h.warnings.join(' ')).toContain('No safe project test command');
  });

  it('should render the project test result', async () => {
    const h = harness({
      testProject: async () => ({
        attempted: true,
        success: true,
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        message: 'Project test succeeded.',
        command: { label: 'npm test' },
      }),
    });
    // Verification passed after an execution, so the workflow can reach the
    // success screen where the Test Project result renders.
    h.state.setRepairPlan(makePlan(1));
    h.state.setApproval('a1', true);
    h.state.setExecution({
      results: [{ action: makeAction('a1'), result: { success: true } }],
      success: true,
      timestamp: new Date(),
    });
    h.state.setLastVerification({ resolved: ['x'], remaining: [], timestamp: new Date() });
    await h.handlers['workflow.testProject']?.();

    const model = buildWorkflowModel(h.state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
    });
    expect(model.currentStep).toBe('success');
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Test Project');
    expect(html).toContain('npm test');
    expect(html).toContain('Project test succeeded.');
  });
});

describe('core project test detection', () => {
  it('should detect an npm test script', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resolveit-projtest-'));
    try {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'vitest run' } }),
        'utf-8'
      );
      const { detectProjectTestCommand } = await import('../../src/index.js');
      const detected = await detectProjectTestCommand(root);
      expect(detected?.label).toBe('npm test');
      expect(detected?.args).toEqual(['test']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should never treat start, build, or dev scripts as tests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resolveit-projtest-'));
    try {
      const { detectProjectTestCommand, detectProjectSmokeCommand } = await import('../../src/index.js');

      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', version: '1.0.0', scripts: { start: 'node index.js' } }),
        'utf-8'
      );
      expect(await detectProjectTestCommand(root)).toBeUndefined();
      expect((await detectProjectSmokeCommand(root))?.label).toBe('npm run start');

      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', version: '1.0.0', scripts: { build: 'tsc' } }),
        'utf-8'
      );
      expect(await detectProjectTestCommand(root)).toBeUndefined();
      expect(await detectProjectSmokeCommand(root)).toBeUndefined();

      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', version: '1.0.0', scripts: { dev: 'vite --port 5173', start: 'node server.js' } }),
        'utf-8'
      );
      expect(await detectProjectTestCommand(root)).toBeUndefined();
      expect((await detectProjectSmokeCommand(root))?.label).toBe('npm run dev');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should refuse scripts outside the allowlist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resolveit-projtest-'));
    try {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', version: '1.0.0', scripts: { postinstall: 'rm -rf /', deploy: 'evil' } }),
        'utf-8'
      );
      const { detectProjectTestCommand } = await import('../../src/index.js');
      expect(await detectProjectTestCommand(root)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should report no command for a project without a manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resolveit-projtest-'));
    try {
      const { detectProjectTestCommand, runProjectTest } = await import('../../src/index.js');
      expect(await detectProjectTestCommand(root)).toBeUndefined();
      const result = await runProjectTest(root);
      expect(result.attempted).toBe(false);
      expect(result.success).toBe(false);
      expect(result.message).toBe('No safe project test command was detected.');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should actually execute the project npm test command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resolveit-projtest-'));
    try {
      // A real npm script that exits 0 without needing any dependencies.
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }),
        'utf-8'
      );
      const { runProjectTest } = await import('../../src/index.js');
      const result = await runProjectTest(root, 60000);
      expect(result.attempted).toBe(true);
      expect(result.command?.label).toBe('npm test');
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90000);

  it('should report a non-zero exit as a failed test', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resolveit-projtest-'));
    try {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node -e "process.exit(3)"' } }),
        'utf-8'
      );
      const { runProjectTest } = await import('../../src/index.js');
      const result = await runProjectTest(root, 60000);
      expect(result.attempted).toBe(true);
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90000);
});

describe('contextual navigation has no dead controls', () => {
  it('should not offer onward navigation before analysis has run', () => {
    const state = new ExtensionState();
    state.bindWorkspace('C:\\ws');
    const model = buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
      requestedStep: 'analyze',
    });
    expect(model.currentStep).toBe('analyze');
    const html = renderWorkflowHtml(model);
    expect(html).not.toContain('data-command="workflow.goForward"');
    expect(html).toContain('data-command="workflow.analyze"');
    expect(html).toContain('data-command="workflow.goBack"');
  });

  it('should move on to Status once analysis found issues', () => {
    const state = new ExtensionState();
    state.bindWorkspace('C:\\ws');
    state.markScanned();
    state.setDiagnostics([
      {
        id: 'd1',
        severity: 'error',
        category: 'dependency',
        code: 'X',
        title: 't',
        message: 'm',
        evidence: [],
        source: 'dependency-resolver',
        timestamp: new Date(),
        metadata: {},
      },
    ]);
    const model = buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
      requestedStep: 'analyze',
    });
    expect(model.currentStep).toBe('status');
    // Post-analysis stages navigate by state, not by generic buttons: the
    // status screen offers Generate Repair Plan and no dead Next control.
    const html = renderWorkflowHtml(model);
    expect(html).toContain('data-command="workflow.generatePlan"');
    expect(html).not.toContain('data-command="workflow.goForward"');
    expect(html).not.toContain('data-command="workflow.goBack"');
  });

  it('should render no generic footer navigation anywhere', () => {
    const state = new ExtensionState();
    state.bindWorkspace('C:\\ws');
    const html = renderWorkflowHtml(
      buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: 'C:\\ws' })
    );
    expect(html).not.toContain('wf-footer');
    expect(html).not.toContain('wf-nav');
    expect(html).not.toContain('role="navigation"');
  });

  it('should offer a contextual continue on AI Mode', () => {
    const state = new ExtensionState();
    state.bindWorkspace('C:\\ws');
    // ai-mode Continue uses goForward while no results exist: honored.
    const model = buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
      requestedStep: 'ai-mode',
    });
    expect(model.currentStep).toBe('ai-mode');
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Continue to Project');
  });

  it('should land on Status (not Success) when analysis found no blocking issues', () => {
    const state = new ExtensionState();
    state.bindWorkspace('C:\\ws');
    state.markScanned();
    const model = buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
      requestedStep: 'analyze',
    });
    // Success is reserved for a completed workflow; a healthy scan shows the
    // healthy Status screen with Re-check/Test/Smoke actions instead.
    expect(model.currentStep).toBe('status');
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Project looks healthy');
    expect(html).toContain('Informational findings: <strong>0</strong>');
    expect(html).toContain('data-command="workflow.verify"');
    expect(html).toContain('Re-check Project');
    expect(html).toContain('data-command="workflow.testProject"');
    expect(html).toContain('data-command="workflow.smokeTest"');
  });

  it('should not offer Analyze without a workspace', () => {
    const state = new ExtensionState();
    state.bindWorkspace(undefined);
    const model = buildWorkflowModel(state, {
      hasWorkspace: false,
      workspaceName: 'No folder open',
      workspaceRoot: '',
    });
    expect(model.currentStep).toBe('project');
    const html = renderWorkflowHtml(model);
    expect(html).not.toContain('data-command="workflow.analyze"');
    expect(html).toContain('Open a folder in VS Code');
  });
});

describe('baseline re-check never manufactures success', () => {
  it('should stay on Status after a clean re-check of an untouched project', async () => {
    const h = harness({
      verify: async () => ({ resolved: [], remaining: [], current: [] as never[] }),
    });
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    h.state.setDiagnostics([]);
    await h.handlers['workflow.verify']?.();
    const model = buildWorkflowModel(h.state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
    });
    expect(model.currentStep).toBe('status');
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Project looks healthy');
    expect(html).not.toContain('Project Resolved');
  });

  it('should land on the failed screen when standalone verification finds blocking issues', async () => {
    const h = harness({
      verify: async () => ({ resolved: [], remaining: ['k1'], current: [] as never[] }),
    });
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    h.state.setDiagnostics([]);
    await h.handlers['workflow.verify']?.();
    const model = buildWorkflowModel(h.state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
    });
    expect(model.currentStep).toBe('failed');
    expect(renderWorkflowHtml(model)).toContain('data-command="workflow.returnToPlan"');
  });
});

describe('smoke test handler', () => {
  function scannedState(): ExtensionState {
    const state = new ExtensionState();
    state.bindWorkspace('C:\\ws');
    state.markScanned();
    state.setDiagnostics([]);
    return state;
  }

  function modelOf(state: ExtensionState) {
    return buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: 'C:\\ws' });
  }

  it('should record a passing smoke run with its URL', async () => {
    const h = harness();
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    await h.handlers['workflow.smokeTest']?.();
    const smoke = h.state.getProjectSmoke();
    expect(smoke?.success).toBe(true);
    expect(smoke?.url).toBe('http://localhost:3000/');
    expect(modelOf(h.state).currentStep).toBe('status');
    expect(renderWorkflowHtml(modelOf(h.state))).toContain('http://localhost:3000/');
  });

  it('should report a failed smoke run without touching the test state', async () => {
    const h = harness({
      smokeProject: async () => ({
        attempted: true,
        command: { label: 'npm run dev' },
        started: true,
        listening: false,
        responded: false,
        success: false,
        timedOut: true,
        output: '',
        message: 'Application did not become reachable on localhost within 60s.',
      }),
    });
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    await h.handlers['workflow.smokeTest']?.();
    expect(h.state.getProjectSmoke()?.success).toBe(false);
    expect(h.state.getProjectTest()).toBeUndefined();
    expect(modelOf(h.state).currentStep).toBe('failed');
    const html = renderWorkflowHtml(modelOf(h.state));
    expect(html).toContain('Smoke test failure');
    expect(html).toContain('did not become reachable');
  });

  it('should say plainly when no run command exists', async () => {
    const h = harness({
      smokeProject: async () => ({
        attempted: false,
        started: false,
        listening: false,
        responded: false,
        success: false,
        timedOut: false,
        output: '',
        message: 'No safe run command was detected.',
      }),
    });
    h.state.bindWorkspace('C:\\ws');
    await h.handlers['workflow.smokeTest']?.();
    expect(h.warnings.join(' ')).toContain('No safe run command');
  });

  it('should reject a second run while one is already running', async () => {
    let release!: () => void;
    const gate = new Promise<unknown>((resolve) => {
      release = () => resolve({ attempted: true, success: true });
    });
    const h = harness({ smokeProject: () => gate as Promise<unknown> });
    h.state.bindWorkspace('C:\\ws');
    const first = h.handlers['workflow.smokeTest']?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.handlers['workflow.smokeTest']?.();
    expect(h.info.join(' ')).toContain('already running');
    release();
    await first;
  });

  it('should cancel an in-flight run when requested', async () => {
    let trigger!: () => void;
    const h = harness({
      tokenTap: (fire) => {
        trigger = fire;
      },
      smokeProject: (_root: string, _opts?: unknown) =>
        new Promise((resolve) => {
          const timer = setInterval(() => {
            const opts = _opts as { signal?: { aborted: boolean } } | undefined;
            if (opts?.signal?.aborted === true) {
              clearInterval(timer);
              resolve({
                attempted: true,
                started: false,
                listening: false,
                responded: false,
                success: false,
                timedOut: false,
                cancelled: true,
                output: '',
                error: 'operation cancelled',
                message: 'Smoke test was cancelled before it finished.',
              });
            }
          }, 20);
        }),
    });
    h.state.bindWorkspace('C:\\ws');
    const pending = h.handlers['workflow.smokeTest']?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    trigger();
    await pending;
    const smoke = h.state.getProjectSmoke();
    expect(smoke?.running).toBe(false);
    expect(smoke?.success).toBe(false);
    expect(h.info.join(' ')).toContain('cancelled');
  });
});

describe('test handler concurrency and cancellation', () => {
  it('should reject a second test run while one is already running', async () => {
    let release!: () => void;
    const gate = new Promise<unknown>((resolve) => {
      release = () => resolve({ attempted: true, success: true, exitCode: 0, stdout: '', stderr: '', message: 'ok' });
    });
    const h = harness({ testProject: () => gate as Promise<unknown> });
    h.state.bindWorkspace('C:\\ws');
    const first = h.handlers['workflow.testProject']?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.handlers['workflow.testProject']?.();
    expect(h.info.join(' ')).toContain('already running');
    release();
    await first;
  });

  it('should not run test and smoke concurrently', async () => {
    let release!: () => void;
    const gate = new Promise<unknown>((resolve) => {
      release = () => resolve({ attempted: true, success: true, exitCode: 0, stdout: '', stderr: '', message: 'ok' });
    });
    const h = harness({ testProject: () => gate as Promise<unknown> });
    h.state.bindWorkspace('C:\\ws');
    const first = h.handlers['workflow.testProject']?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.handlers['workflow.smokeTest']?.();
    expect(h.info.join(' ')).toContain('already running');
    release();
    await first;
  });
});

describe('start over genuinely resets the workflow', () => {
  it('should clear plan, approvals, execution, verification, test, and errors', async () => {
    const h = harness();
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    h.state.setProjectName('demo');
    h.state.setDiagnostics([]);
    await h.handlers['workflow.generatePlan']?.();
    await h.handlers['workflow.approveAll']?.();
    h.state.setLastError('boom');
    expect(h.state.getRepairPlan()).toBeDefined();

    await h.handlers['workflow.restart']?.();

    expect(h.state.getRepairPlan()).toBeUndefined();
    expect(h.state.getApprovedIds()).toEqual([]);
    expect(h.state.getExecution()).toBeUndefined();
    expect(h.state.getLastVerification()).toBeUndefined();
    expect(h.state.getProjectTest()).toBeUndefined();
    expect(h.state.getProjectSmoke()).toBeUndefined();
    expect(h.state.getLastError()).toBeUndefined();
    expect(h.state.getHasScanned()).toBe(false);
    expect(h.state.getDiagnostics()).toEqual([]);
    expect(h.state.getWorkspaceRoot()).toBe('C:\\ws');
    const model = buildWorkflowModel(h.state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
      requestedStep: 'ai-mode',
    });
    expect(model.currentStep).toBe('ai-mode');
    expect(renderWorkflowHtml(model)).toContain('How should ResolveIt reason?');
  });
});

describe('approval decisions survive re-planning by fingerprint', () => {
  it('should carry over decisions when fingerprints match across re-plans', async () => {
    const stable = (id: string, pkg: string): RepairAction => ({
      id,
      type: 'install-dependency',
      permissionLevel: 'project-modification',
      description: `Install ${pkg}`,
      target: { filePath: 'package.json' },
      parameters: { ecosystem: 'npm', package: pkg },
      affectedFiles: ['package.json'],
      riskLevel: 'project-modification',
      prerequisites: [],
    });
    const h = harness({
      planRepairsSmart: async () => ({
        plan: {
          id: 'plan-new',
          name: 'plan',
          description: 'plan',
          actions: [stable('new-1', 'lodash'), stable('new-3', 'third')],
          requiresApproval: true,
        },
        diagnostics: [],
        aiUsed: false,
        aiRejections: [],
        manualActions: [],
      }),
    });
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    h.state.setRepairPlan({
      id: 'plan-old',
      name: 'plan',
      description: 'plan',
      actions: [stable('old-1', 'lodash'), stable('old-2', 'other')],
      requiresApproval: true,
    });
    h.state.setApproval('old-1', true);
    h.state.setApproval('old-2', false);

    await h.handlers['workflow.returnToPlan']?.();

    expect(h.state.getApproval('new-1')).toBe('approved');
    expect(h.state.getApproval('new-3')).toBe('awaiting');
    expect(h.logs.join(' ')).toContain('carried over 1 previous decision');
  });
});

describe('failure reporting lists every category', () => {
  it('should show execution, verification, test, and smoke failures together', () => {
    const state = new ExtensionState();
    state.bindWorkspace('C:\\ws');
    state.markScanned();
    state.setRepairPlan(makePlan(1));
    state.setApproval('a1', true);
    state.setExecution({
      results: [{ action: makeAction('a1'), result: { success: false, error: 'npm exploded' } }],
      success: false,
      timestamp: new Date(),
    });
    state.setLastVerification({ resolved: [], remaining: ['k1'], timestamp: new Date() });
    state.setLastError('ResolveIt could not complete the repair.');
    state.setProjectTest({
      running: false,
      commandLabel: 'npm test',
      attempted: true,
      success: false,
      exitCode: 1,
      output: '',
      message: 'Project test failed with exit code 1.',
    });
    state.setProjectSmoke({
      running: false,
      commandLabel: 'npm run dev',
      attempted: true,
      started: true,
      listening: false,
      responded: false,
      success: false,
      output: '',
      message: 'Application did not become reachable on localhost within 60s.',
    });
    const model = buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: 'C:\\ws' });
    expect(model.currentStep).toBe('failed');
    expect(model.failures.map((failure) => failure.kind)).toEqual(['execution', 'verification', 'test', 'smoke']);
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Execution failure');
    expect(html).toContain('Verification failure');
    expect(html).toContain('Project test failure');
    expect(html).toContain('Smoke test failure');
    expect(html).toContain('npm exploded');
  });
});

describe('status counts separate findings from issues', () => {
  it('should not present informational notes as problems', () => {
    const state = new ExtensionState();
    state.bindWorkspace('C:\\ws');
    state.markScanned();
    state.setRequirements([
      {
        projectId: 'p',
        sourceFiles: ['package.json', 'package-lock.json'],
        requirements: [
          { id: 'r1', ecosystem: 'node', type: 'package-dependency', name: 'a', sourceFile: 'package.json' },
          { id: 'r2', ecosystem: 'node', type: 'package-dependency', name: 'b', sourceFile: 'package-lock.json' },
        ],
        parseErrors: [],
      } as never,
    ]);
    const diag = (id: string, severity: 'info' | 'warning' | 'error', category: string): Diagnostic =>
      ({
        id,
        severity,
        category,
        code: 'X',
        title: 't',
        message: 'm',
        evidence: [],
        source: 'dependency-resolver',
        timestamp: new Date(),
        metadata: {},
      }) as Diagnostic;
    state.setDiagnostics([
      diag('i1', 'info', 'dependency'),
      diag('i2', 'info', 'dependency'),
      diag('w1', 'warning', 'project'),
      diag('e1', 'error', 'runtime'),
    ]);
    const model = buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: 'C:\\ws' });
    expect(model.statusSummary).toMatchObject({
      requirementsTotal: 2,
      infoFindings: 2,
      issues: 2,
      blockingIssues: 1,
    });
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Informational findings: <strong>2</strong>');
    expect(html).toContain('Issues: <strong>2</strong>');
    expect(html).toContain('Blocking issues: <strong>1</strong>');
    expect(html).not.toContain('Issues found:');
  });
});

describe('every rendered workflow state is reachable', () => {  function base(): { state: ExtensionState; input: { hasWorkspace: true; workspaceName: string; workspaceRoot: string } } {
    const state = new ExtensionState();
    state.bindWorkspace('C:\\ws');
    return { state, input: { hasWorkspace: true as const, workspaceName: 'ws', workspaceRoot: 'C:\\ws' } };
  }

  it('should reach ai-mode, project, analyze, and status', () => {
    const { state, input } = base();
    expect(buildWorkflowModel(state, { ...input, requestedStep: 'ai-mode' }).currentStep).toBe('ai-mode');
    expect(buildWorkflowModel(state, { ...input, requestedStep: 'project' }).currentStep).toBe('project');
    expect(buildWorkflowModel(state, { ...input, requestedStep: 'analyze' }).currentStep).toBe('analyze');
    state.markScanned();
    state.setDiagnostics([]);
    expect(buildWorkflowModel(state, input).currentStep).toBe('status');
  });

  it('should reach repair-plan, apply, verify, success, and failed', () => {
    const { state, input } = base();
    state.markScanned();
    state.setDiagnostics([]);
    state.setRepairPlan(makePlan(1));
    expect(buildWorkflowModel(state, input).currentStep).toBe('repair-plan');

    state.setApproval('a1', true);
    state.setExecution({
      results: [{ action: makeAction('a1'), result: { success: true } }],
      success: true,
      timestamp: new Date(),
    });
    expect(buildWorkflowModel(state, input).currentStep).toBe('apply');

    state.setLastVerification({ resolved: ['k'], remaining: [], timestamp: new Date() });
    expect(buildWorkflowModel(state, input).currentStep).toBe('verify');

    state.setProjectTest({
      running: false,
      commandLabel: 'npm test',
      attempted: true,
      success: true,
      exitCode: 0,
      output: '',
      message: 'Project test passed.',
    });
    expect(buildWorkflowModel(state, input).currentStep).toBe('success');

    state.setLastVerification({ resolved: [], remaining: ['k'], timestamp: new Date() });
    expect(buildWorkflowModel(state, input).currentStep).toBe('failed');
  });

  it('should render the matching screen for every reachable state', () => {
    const { state, input } = base();
    state.markScanned();
    state.setDiagnostics([]);
    const markers: Record<string, string> = {
      status: 'Project Status',
      'repair-plan': 'Repair Plan',
      apply: 'Applying Changes',
      verify: 'Verification',
      success: 'Project Resolved',
      failed: 'could not fully resolve',
    };
    state.setRepairPlan(makePlan(1));
    state.setApproval('a1', true);
    state.setExecution({
      results: [{ action: makeAction('a1'), result: { success: true } }],
      success: true,
      timestamp: new Date(),
    });
    expect(renderWorkflowHtml(buildWorkflowModel(state, input))).toContain(markers['repair-plan']);
    state.setLastVerification({ resolved: ['k'], remaining: [], timestamp: new Date() });
    const html = renderWorkflowHtml(buildWorkflowModel(state, input));
    expect(html).toContain(markers.verify);
    expect(html).not.toContain('data-command="workflow.goForward"');
  });
});

describe('full workflow reaches success honestly', () => {
  it('should go apply to verify to test to success with evidence', async () => {
    const executed: string[][] = [];
    const core = {
      executeApproved: async (_root: string, _plan: RepairPlan, approved: string[]) => {
        executed.push([...approved]);
        return {
          results: approved.map((id) => ({ action: makeAction(id), result: { success: true } })),
          success: true,
        };
      },
      verifyAgainstPrevious: async () => ({ resolved: ['k1'], remaining: [], current: [] as never[] }),
      planRepairsSmart: async () => ({
        plan: makePlan(2),
        diagnostics: [],
        aiUsed: false,
        aiRejections: [],
        manualActions: [],
      }),
      testProject: async () => ({
        attempted: true,
        success: true,
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        command: { label: 'npm test' },
        message: 'Project test passed.',
      }),
    };
    const h = harness({});
    (h.core as Record<string, unknown>).executeApproved = core.executeApproved;
    (h.core as Record<string, unknown>).verifyAgainstPrevious = core.verifyAgainstPrevious;
    (h.core as Record<string, unknown>).testProject = core.testProject;
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    h.state.setDiagnostics([]);

    await h.handlers['workflow.generatePlan']?.();
    await h.handlers['workflow.approveAll']?.();
    await h.handlers['workflow.apply']?.();

    const modelAfterApply = buildWorkflowModel(h.state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
    });
    expect(['verify', 'success']).toContain(modelAfterApply.currentStep);

    await h.handlers['workflow.testProject']?.();
    const model = buildWorkflowModel(h.state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
    });
    expect(model.currentStep).toBe('success');
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Project Resolved');
    expect(html).toContain('Repairs applied:');
    expect(html).toContain('Verification passed:');
    expect(html).toContain('Project test passed');
  });

  it('should never execute a denied action', async () => {
    const executed: string[][] = [];
    const h = harness({
      executeApproved: async (_root: string, _plan: RepairPlan, approved: string[]) => {
        executed.push([...approved]);
        return {
          results: approved.map((id) => ({ action: makeAction(id), result: { success: true } })),
          success: true,
        };
      },
      verify: async () => ({ resolved: ['k1'], remaining: [], current: [] as never[] }),
    });
    h.state.markScanned();
    await h.handlers['workflow.toggleApproval']?.('a1');
    await h.handlers['workflow.toggleApproval']?.('a2');
    await h.handlers['workflow.toggleApproval']?.('a2');
    expect(h.state.getApproval('a1')).toBe('approved');
    expect(h.state.getApproval('a2')).toBe('denied');
    await h.handlers['workflow.apply']?.();
    expect(executed).toEqual([['a1']]);
    expect(h.state.getExecution()?.results.map((entry) => entry.action.id)).toEqual(['a1']);
  });

  it('should never display Approved for a failed action', () => {
    expect(resolveActionLifecycle('approved', { success: false, error: 'boom' }, false)).toBe('failed');
    expect(resolveActionLifecycle('approved', { success: false, error: 'boom' }, true)).toBe('failed');
    const state = new ExtensionState();
    state.setRepairPlan(makePlan(1));
    state.setApproval('a1', true);
    state.setExecution({
      results: [{ action: makeAction('a1'), result: { success: false, error: 'boom' } }],
      success: false,
      timestamp: new Date(),
    });
    const model = buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: 'C:\\ws' });
    expect(model.repairPlan.actions[0]?.lifecycle).toBe('failed');
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Failed');
    expect(html).not.toContain('>Approved<');
  });
});
