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
import { WORKFLOW_ALLOWED_COMMANDS } from '../src/workflow/messages.js';
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
  planDeterministicRepairs?: () => Promise<{
    plan: RepairPlan;
    diagnostics: never[];
    manualActions: never[];
  }>;
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
    planDeterministicRepairs:
      options.planDeterministicRepairs ??
      (async () => ({ plan: makePlan(2), diagnostics: [] as never[], manualActions: [] as never[] })),
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

describe('core project test detection (internal API, not part of the workflow)', () => {
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
    expect(html).not.toContain('data-command="workflow.goBack"');
    expect(html).toContain('data-command="workflow.analyze"');
    expect(html).toContain('data-command="workflow.gotoProject"');
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
    // status screen offers one primary action and no generic Back/Next.
    const html = renderWorkflowHtml(model);
    expect(html).toContain('data-command="workflow.generatePlan"');
    expect(html).toContain('View Repair Plan');
    expect(html).not.toContain('data-command="workflow.goForward"');
    expect(html).not.toContain('data-command="workflow.goBack"');
    expect(html).not.toContain('data-command="workflow.gotoAiMode"');
    expect(html).not.toContain('data-command="workflow.gotoProject"');
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
    // ai-mode Continue moves explicitly to Project while no results exist.
    const model = buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
      requestedStep: 'ai-mode',
    });
    expect(model.currentStep).toBe('ai-mode');
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Continue to Project');
    expect(html).toContain('data-command="workflow.gotoProject"');
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
    // Done is reserved for a finished workflow; a healthy scan shows the
    // healthy Status screen with a single Verify Project action instead.
    expect(model.currentStep).toBe('status');
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Healthy');
    expect(html).toContain('ResolveIt did not find any problems that require repair.');
    expect(html).toContain('Requirements: <strong>0</strong>');
    expect(html).toContain('Installed dependencies: <strong>0</strong>');
    expect(html).toContain('Dependencies to install: <strong>0</strong>');
    expect(html).not.toContain('Informational findings');
    expect(html).not.toContain('Blocking issues');
    expect(html).not.toContain('blocking diagnostic');
    expect(html).toContain('data-command="workflow.verify"');
    expect(html).toContain('Verify Project');
    expect(html).not.toContain('data-command="workflow.testProject"');
    expect(html).not.toContain('data-command="workflow.smokeTest"');
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

describe('healthy projects reach Verify and Done without launching anything', () => {
  it('should reach Verify after a clean check of an untouched project', async () => {
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
    expect(model.currentStep).toBe('verify');
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Verify Changes');
    expect(html).toContain('data-command="workflow.finish"');
  });

  it('should reach Done after finishing a clean check, with no dev/start requirement', async () => {
    const h = harness({
      verify: async () => ({ resolved: [], remaining: [], current: [] as never[] }),
    });
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    h.state.setDiagnostics([]);
    await h.handlers['workflow.verify']?.();
    await h.handlers['workflow.finish']?.();
    const model = buildWorkflowModel(h.state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
    });
    expect(model.currentStep).toBe('success');
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Done');
    expect(html).toContain('Project looks healthy');
    expect(html).not.toContain('Smoke');
    expect(html).not.toContain('Test Project');
    expect(html).not.toContain('Not responding');
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

describe('start over genuinely resets the workflow', () => {
  it('should clear plan, approvals, execution, verification, completion, and errors', async () => {
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
    expect(h.state.isWorkflowCompleted()).toBe(false);
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
      planDeterministicRepairs: async () => ({
        plan: {
          id: 'plan-new',
          name: 'plan',
          description: 'plan',
          actions: [stable('new-1', 'lodash'), stable('new-3', 'third')],
          requiresApproval: true,
        },
        diagnostics: [],
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
  it('should show execution and verification failures together', () => {
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
    const model = buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: 'C:\\ws' });
    expect(model.currentStep).toBe('failed');
    expect(model.failures.map((failure) => failure.kind)).toEqual(['execution', 'verification']);
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Execution failure');
    expect(html).toContain('Verification failure');
    expect(html).toContain('npm exploded');
    expect(html).not.toContain('Smoke');
    expect(html).not.toContain('Test Project');
  });
});

describe('status keeps internal counts while showing dependency facts', () => {
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
    expect(html).toContain('Requirements: <strong>2</strong>');
    expect(html).toContain('Installed dependencies: <strong>2</strong>');
    expect(html).toContain('Dependencies to install: <strong>0</strong>');
    expect(html).not.toContain('Informational findings');
    expect(html).not.toContain('Blocking issues');
    expect(html).not.toContain('Issues: <strong>');
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

    // A clean check lands on Verify; finishing it reaches Done. No test or
    // app-launch step is required in between.
    state.setLastVerification({ resolved: ['k'], remaining: [], timestamp: new Date() });
    expect(buildWorkflowModel(state, input).currentStep).toBe('verify');

    state.markWorkflowCompleted();
    expect(buildWorkflowModel(state, input).currentStep).toBe('success');

    state.clearWorkflowCompleted();
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
      apply: 'Applying Fixes',
      verify: 'Verify Changes',
      success: 'Final check passed',
      failed: 'Problems Remain',
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
    state.markWorkflowCompleted();
    const doneHtml = renderWorkflowHtml(buildWorkflowModel(state, input));
    expect(doneHtml).toContain(markers.success);
    expect(doneHtml).toContain('Start Over');
  });
});

describe('full workflow reaches success honestly', () => {
  it('should go status to plan to apply to verify to done with evidence', async () => {
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
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    h.state.setDiagnostics([]);

    await h.handlers['workflow.generatePlan']?.();
    expect(
      buildWorkflowModel(h.state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: 'C:\\ws' }).currentStep
    ).toBe('repair-plan');
    await h.handlers['workflow.approveAll']?.();
    await h.handlers['workflow.apply']?.();

    const modelAfterApply = buildWorkflowModel(h.state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
    });
    expect(modelAfterApply.currentStep).toBe('verify');

    await h.handlers['workflow.finish']?.();
    const model = buildWorkflowModel(h.state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
    });
    expect(model.currentStep).toBe('success');
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Done');
    expect(html).toContain('Fixes applied:');
    expect(html).toContain('Final check passed:');
    expect(html).not.toContain('Smoke');
  });

  it('should loop back to the plan when the final check still finds problems', async () => {
    const h = harness({
      verify: async () => ({ resolved: [], remaining: ['k1'], current: [] as never[] }),
    });
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    h.state.setDiagnostics([]);
    await h.handlers['workflow.generatePlan']?.();
    await h.handlers['workflow.approveAll']?.();
    await h.handlers['workflow.apply']?.();
    expect(
      buildWorkflowModel(h.state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: 'C:\\ws' }).currentStep
    ).toBe('failed');
    await h.handlers['workflow.returnToPlan']?.();
    expect(
      buildWorkflowModel(h.state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: 'C:\\ws' }).currentStep
    ).toBe('repair-plan');
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

describe('simplified beginner workflow regressions', () => {
  function scannedHealthy(): ExtensionState {
    const state = new ExtensionState();
    state.bindWorkspace('C:\\ws');
    state.markScanned();
    state.setDiagnostics([]);
    return state;
  }

  function scannedUnhealthy(): ExtensionState {
    const state = scannedHealthy();
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
      } as never,
    ]);
    return state;
  }

  function htmlOf(state: ExtensionState): string {
    return renderWorkflowHtml(
      buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: 'C:\\ws' })
    );
  }

  it('should expose no smoke or test-project concepts on the Status screen', () => {
    for (const state of [scannedHealthy(), scannedUnhealthy()]) {
      const html = htmlOf(state);
      expect(html).not.toContain('Test Project');
      expect(html).not.toContain('Smoke Test');
      expect(html).not.toContain('Smoke test');
      expect(html).not.toContain('Run / Smoke');
      expect(html).not.toContain('Not responding');
      expect(html).not.toContain('dev/start');
      expect(html).not.toContain('start script');
      expect(html).not.toContain('localhost');
      expect(html).not.toContain('workflow.testProject');
      expect(html).not.toContain('workflow.smokeTest');
    }
  });

  it('should expose no smoke or test-project concepts on any screen', () => {
    const state = scannedUnhealthy();
    state.setRepairPlan(makePlan(1));
    state.setApproval('a1', true);
    state.setExecution({
      results: [{ action: makeAction('a1'), result: { success: true } }],
      success: true,
      timestamp: new Date(),
    });
    state.setLastVerification({ resolved: ['k'], remaining: [], timestamp: new Date() });
    expect(htmlOf(state)).toContain('Verify Changes');
    state.markWorkflowCompleted();
    const done = htmlOf(state);
    expect(done).toContain('Done');
    expect(done).not.toContain('Smoke');
    expect(done).not.toContain('Test Project');
    state.clearWorkflowCompleted();
    state.setLastVerification({ resolved: [], remaining: ['k'], timestamp: new Date() });
    const failed = htmlOf(state);
    expect(failed).toContain('Problems Remain');
    expect(failed).not.toContain('Smoke');
    expect(failed).not.toContain('Test Project');
  });

  it('should send unhealthy projects to the repair plan with one primary action', () => {
    const html = htmlOf(scannedUnhealthy());
    expect(html).toContain('Problems Found');
    expect(html).toContain('View Repair Plan');
    expect(html).toContain('data-command="workflow.generatePlan"');
  });

  it('should send healthy projects to Verify with one primary action', () => {
    const html = htmlOf(scannedHealthy());
    expect(html).toContain('Healthy');
    expect(html).toContain('Verify Project');
    expect(html).toContain('data-command="workflow.verify"');
  });

  it('should finish without any dev/start project setup', async () => {
    const h = harness({
      verify: async () => ({ resolved: [], remaining: [], current: [] as never[] }),
    });
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    // A bare manifest with no dev/start/test scripts at all.
    h.state.setDiagnostics([]);
    await h.handlers['workflow.verify']?.();
    await h.handlers['workflow.finish']?.();
    const model = buildWorkflowModel(h.state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
    });
    expect(model.currentStep).toBe('success');
  });

  it('should refuse to finish while problems remain', async () => {
    const h = harness({
      verify: async () => ({ resolved: [], remaining: ['k1'], current: [] as never[] }),
    });
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    h.state.setDiagnostics([]);
    await h.handlers['workflow.verify']?.();
    await h.handlers['workflow.finish']?.();
    expect(h.state.isWorkflowCompleted()).toBe(false);
    expect(
      buildWorkflowModel(h.state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: 'C:\\ws' }).currentStep
    ).toBe('failed');
  });

  it('should reset Done back to AI Mode on Start Over', async () => {
    const h = harness({
      verify: async () => ({ resolved: [], remaining: [], current: [] as never[] }),
    });
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    h.state.setDiagnostics([]);
    await h.handlers['workflow.verify']?.();
    await h.handlers['workflow.finish']?.();
    await h.handlers['workflow.restart']?.();
    const model = buildWorkflowModel(h.state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
      requestedStep: 'ai-mode',
    });
    expect(model.currentStep).toBe('ai-mode');
  });

  it('should give every visible primary button a working handler', async () => {
    const h = harness({
      verify: async () => ({ resolved: [], remaining: [], current: [] as never[] }),
    });
    h.state.bindWorkspace('C:\\ws');
    const seen = new Set<string>();
    const collect = (html: string): void => {
      for (const match of html.matchAll(/data-command="(workflow\.[a-zA-Z]+)"/g)) {
        seen.add(match[1] as string);
      }
    };
    // Walk every reachable screen and collect its buttons.
    collect(htmlOf(scannedHealthy()));
    collect(htmlOf(scannedUnhealthy()));
    h.state.markScanned();
    h.state.setDiagnostics([]);
    await h.handlers['workflow.verify']?.();
    collect(htmlOf(h.state));
    await h.handlers['workflow.finish']?.();
    collect(htmlOf(h.state));
    h.state.clearWorkflowCompleted();
    h.state.setLastVerification({ resolved: [], remaining: ['k'], timestamp: new Date() });
    collect(htmlOf(h.state));
    // AI Mode / Project / Analyze / Repair Plan / Apply screens.
    const fresh = new ExtensionState();
    fresh.bindWorkspace('C:\\ws');
    collect(
      renderWorkflowHtml(
        buildWorkflowModel(fresh, {
          hasWorkspace: true,
          workspaceName: 'ws',
          workspaceRoot: 'C:\\ws',
          requestedStep: 'ai-mode',
        })
      )
    );
    collect(
      renderWorkflowHtml(
        buildWorkflowModel(fresh, {
          hasWorkspace: true,
          workspaceName: 'ws',
          workspaceRoot: 'C:\\ws',
          requestedStep: 'project',
        })
      )
    );
    collect(
      renderWorkflowHtml(
        buildWorkflowModel(fresh, {
          hasWorkspace: true,
          workspaceName: 'ws',
          workspaceRoot: 'C:\\ws',
          requestedStep: 'analyze',
        })
      )
    );
    const planned = scannedUnhealthy();
    planned.setRepairPlan(makePlan(1));
    collect(htmlOf(planned));
    for (const command of seen) {
      // Contextual AI Mode/Project moves are view-level navigation with
      // explicit targets; everything else needs a command handler.
      const handled =
        h.handlers[command] !== undefined ||
        command === 'workflow.gotoAiMode' ||
        command === 'workflow.gotoProject';
      expect(handled, `button ${command} must have a working handler`).toBe(true);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('should register no obsolete workflow commands', () => {
    for (const obsolete of ['workflow.testProject', 'workflow.smokeTest', 'workflow.goBack', 'workflow.goForward']) {
      expect(WORKFLOW_ALLOWED_COMMANDS.has(obsolete)).toBe(false);
    }
    const h = harness();
    for (const obsolete of ['workflow.testProject', 'workflow.smokeTest', 'workflow.goBack', 'workflow.goForward']) {
      expect(h.handlers[obsolete]).toBeUndefined();
    }
  });
});

describe('status distinguishes declared, satisfied, missing, and mismatched dependencies', () => {
  function expressRequirement(): never {
    return {
      id: 'r1',
      ecosystem: 'node',
      type: 'package-dependency',
      name: 'express',
      versionConstraint: '^5.1.0',
      sourceFile: 'package.json',
      sourceSection: 'dependencies.production',
      optional: false,
      metadata: { scope: 'production' },
    } as never;
  }

  function expressDiagnostic(code: 'DEPENDENCY_PACKAGE_MISSING' | 'DEPENDENCY_PACKAGE_VERSION_MISMATCH'): never {
    return {
      id: 'd1',
      severity: 'error',
      category: 'dependency',
      code,
      title: 'Dependency: express',
      message: code === 'DEPENDENCY_PACKAGE_MISSING' ? 'not currently installed' : 'installed version is 4.21.2',
      evidence: [],
      source: 'dependency-resolver',
      timestamp: new Date(),
      metadata: {},
      requirement: expressRequirement(),
    } as never;
  }

  function stateWith(requirements: never[], diagnostics: never[]): ExtensionState {
    const state = new ExtensionState();
    state.bindWorkspace('C:\\ws');
    state.markScanned();
    state.setRequirements([
      { projectId: 'p', sourceFiles: ['package.json'], requirements, parseErrors: [] } as never,
    ]);
    state.setDiagnostics(diagnostics);
    return state;
  }

  function statusHtml(state: ExtensionState): string {
    return renderWorkflowHtml(
      buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: 'C:\\ws' })
    );
  }

  it('should report a missing dependency as Problems Found, never Healthy', () => {
    const state = stateWith([expressRequirement()], [expressDiagnostic('DEPENDENCY_PACKAGE_MISSING')]);
    const model = buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
    });
    expect(model.currentStep).toBe('status');
    expect(model.statusSummary.dependencies).toMatchObject({
      required: 1,
      satisfied: 0,
      missing: 1,
      mismatched: 0,
    });
    const html = statusHtml(state);
    expect(html).toContain('Problems Found');
    expect(html).not.toContain('Healthy');
    expect(html).toContain('Requirements: <strong>1</strong>');
    expect(html).toContain('Installed dependencies: <strong>0</strong>');
    expect(html).toContain('Dependencies to install: <strong>1</strong>');
    expect(html).not.toContain('Informational findings');
    expect(html).not.toContain('Blocking issues');
    expect(html).not.toContain('blocking diagnostic');
    expect(html).toContain('Missing dependency');
    expect(html).toContain('express ^5.1.0');
    expect(html).toContain('but it is not currently installed');
    expect(html).toContain('View Repair Plan');
  });

  it('should report a version mismatch as a problem with the installed version named', () => {
    const state = stateWith([expressRequirement()], [expressDiagnostic('DEPENDENCY_PACKAGE_VERSION_MISMATCH')]);
    const model = buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
    });
    expect(model.statusSummary.dependencies).toMatchObject({
      required: 1,
      satisfied: 0,
      missing: 0,
      mismatched: 1,
    });
    const html = statusHtml(state);
    expect(html).toContain('Problems Found');
    expect(html).toContain('Requirements: <strong>1</strong>');
    expect(html).toContain('Installed dependencies: <strong>0</strong>');
    expect(html).toContain('Dependencies to install: <strong>1</strong>');
    expect(html).toContain('Mismatched dependency');
    expect(html).not.toContain('Informational findings');
    expect(html).not.toContain('Blocking issues');
    expect(html).toContain('View Repair Plan');
  });

  it('should say plainly when every required dependency is satisfied', () => {
    const state = stateWith([expressRequirement()], []);
    const model = buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: 'C:\\ws',
    });
    expect(model.statusSummary.dependencies).toMatchObject({
      required: 1,
      satisfied: 1,
      missing: 0,
      mismatched: 0,
    });
    const html = statusHtml(state);
    expect(html).toContain('Healthy');
    expect(html).toContain('Requirements: <strong>1</strong>');
    expect(html).toContain('Installed dependencies: <strong>1</strong>');
    expect(html).toContain('Dependencies to install: <strong>0</strong>');
    expect(html).not.toContain('Informational findings');
    expect(html).not.toContain('Blocking issues');
    expect(html).not.toContain('Issues: <strong>');
    expect(html).toContain('All required dependencies are already installed. No changes are needed.');
    expect(html).toContain('Verify Project');
  });

  it('should show the workspace folder name when no formal project name exists', () => {
    const state = new ExtensionState();
    state.bindWorkspace('C:\\ResolveIt-Test-Missing');
    const model = buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: 'ResolveIt-Test-Missing',
      workspaceRoot: 'C:\\ResolveIt-Test-Missing',
      requestedStep: 'project',
    });
    expect(model.currentStep).toBe('project');
    expect(model.projectName).toBe('ResolveIt-Test-Missing');
    const html = renderWorkflowHtml(model);
    expect(html).not.toContain('(no project detected)');
    expect(html).toContain('ResolveIt-Test-Missing');
  });

  it('should prefer a detected project name over the folder name', () => {
    const state = new ExtensionState();
    state.bindWorkspace('C:\\ResolveIt-Test-Missing');
    state.setProjectName('resolveit-test-missing');
    const model = buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: 'ResolveIt-Test-Missing',
      workspaceRoot: 'C:\\ResolveIt-Test-Missing',
      requestedStep: 'project',
    });
    expect(model.projectName).toBe('resolveit-test-missing');
  });

  it('should fall back to a placeholder only with no folder and no name', () => {
    const state = new ExtensionState();
    state.bindWorkspace(undefined);
    const model = buildWorkflowModel(state, {
      hasWorkspace: false,
      workspaceName: 'No folder open',
      workspaceRoot: '',
      requestedStep: 'project',
    });
    expect(model.projectName).toBe('(no project detected)');
  });
});
