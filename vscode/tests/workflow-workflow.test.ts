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
  aiProvider?: 'none' | 'local' | 'external';
  root?: string;
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
  };

  const ctx: WorkflowCommandContext = {
    state,
    logger: new Logger({ appendLine: (line: string) => logs.push(line), show: () => undefined }),
    core: core as unknown as CoreClient,
    showMessage: (m) => info.push(m),
    showWarning: (m) => warnings.push(m),
    showError: (m) => errors.push(m),
    showProgress: (_t, task) => task(() => undefined),
    showCancellableProgress: (_t, task) =>
      task(() => undefined, { isCancellationRequested: false, onCancellationRequested: () => undefined }),
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
    // Verification passed, so the workflow is on the success screen where the
    // Test Project action lives.
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

  it('should fall back to start, then build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resolveit-projtest-'));
    try {
      const { detectProjectTestCommand } = await import('../../src/index.js');

      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', version: '1.0.0', scripts: { start: 'node index.js' } }),
        'utf-8'
      );
      expect((await detectProjectTestCommand(root))?.label).toBe('npm run start');

      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'x', version: '1.0.0', scripts: { build: 'tsc' } }),
        'utf-8'
      );
      expect((await detectProjectTestCommand(root))?.label).toBe('npm run build');
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

describe('navigation has no dead actions', () => {
  it('should not offer Next before analysis has run', () => {
    const state = new ExtensionState();
    state.bindWorkspace('C:\\ws');
    const model = buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
      requestedStep: 'analyze',
    });
    expect(model.currentStep).toBe('analyze');
    expect(model.canLeaveAnalyze).toBe(false);
    expect(model.canGoForward).toBe(false);

    const html = renderWorkflowHtml(model);
    expect(html).not.toContain('data-command="workflow.goForward"');
    expect(html).toContain('data-command="workflow.analyze"');
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
    expect(model.canGoForward).toBe(true);
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
    // Success is reserved for actual verification; a healthy scan shows the
    // healthy Status screen with Verify/Test actions instead.
    expect(model.currentStep).toBe('status');
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Project looks healthy');
    expect(html).toContain('data-command="workflow.verify"');
    expect(html).toContain('data-command="workflow.testProject"');
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

describe('standalone verification reaches Success on a healthy project', () => {
  it('should verify and resolve to success without any repairs', async () => {
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
    expect(model.currentStep).toBe('success');
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Project Resolved');
    expect(html).toContain('Project looks healthy');
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
