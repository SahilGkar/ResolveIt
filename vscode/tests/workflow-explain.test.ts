import { describe, it, expect, beforeEach } from 'vitest';
import { __reset } from './vscode-mock.js';
import { ExtensionState } from '../src/state.js';
import { Logger } from '../src/ui/output.js';
import { CoreClient } from '../src/core.js';
import { createWorkflowCommandHandlers, type WorkflowCommandContext } from '../src/workflow/commands.js';
import { buildWorkflowModel } from '../src/workflow/model.js';
import { renderWorkflowHtml } from '../src/workflow/render.js';
import type { RepairAction, RepairPlan, RepairResult, Diagnostic } from '../../src/index.js';

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

function makePlan(): RepairPlan {
  return {
    id: 'plan-1',
    name: 'plan',
    description: 'Install missing dependencies',
    actions: [makeAction('a1', 'Install express ^5.1.0'), makeAction('a2', 'Install lodash ^4.17.21')],
    requiresApproval: true,
  };
}

function makeExplanation() {
  return {
    summary: 'Two missing dependencies need installing.',
    actions: [
      {
        actionId: 'a1',
        title: 'express',
        whatItMeans: 'A web framework.',
        whyDetected: 'Declared but not installed.',
        whatResolveItWillDo: 'Run the safe installer.',
        expectedResult: 'Imports resolve.',
      },
      {
        actionId: 'a2',
        title: 'lodash',
        whatItMeans: 'A utility library.',
        whyDetected: 'Declared but not installed.',
        whatResolveItWillDo: 'Run the safe installer.',
        expectedResult: 'Imports resolve.',
      },
    ],
  };
}

interface ExplainHarness {
  readonly state: ExtensionState;
  readonly handlers: ReturnType<typeof createWorkflowCommandHandlers>;
  readonly core: { [key: string]: unknown };
  readonly executed: string[][];
  readonly seenExplainArgs: unknown[];
}

function harness(explainImpl?: (...args: never[]) => Promise<unknown>): ExplainHarness {
  const state = new ExtensionState();
  const executed: string[][] = [];
  const seenExplainArgs: unknown[] = [];
  const plan = makePlan();
  const core = {
    planDeterministicRepairs: async () => ({
      plan: makePlan(),
      diagnostics: [] as never[],
      manualActions: [] as never[],
    }),
    executeApproved: async (_root: string, _plan: RepairPlan, approved: string[]) => {
      executed.push([...approved]);
      return {
        results: approved.map((id) => ({
          action: plan.actions.find((a) => a.id === id)!,
          result: { success: true } as RepairResult,
        })),
        success: true,
      };
    },
    verifyAgainstPrevious: async () => ({ resolved: ['x'], remaining: [] as string[], current: [] as never[] }),
    explainRepairPlan:
      explainImpl ??
      (async (...args: never[]) => {
        seenExplainArgs.push(args);
        return { status: 'ready', explanation: makeExplanation() };
      }),
  };
  const ctx: WorkflowCommandContext = {
    state,
    logger: new Logger({ appendLine: () => undefined, show: () => undefined }),
    core: core as unknown as CoreClient,
    showMessage: () => undefined,
    showWarning: () => undefined,
    showError: () => undefined,
    showProgress: (_t, task) => task(() => undefined),
    showCancellableProgress: (_t, task) =>
      task(() => undefined, { isCancellationRequested: false, onCancellationRequested: () => undefined }),
    getAIConfig: () => ({ provider: 'local' }) as never,
    getMaxIterations: () => 3,
    getWorkspaceRoot: () => 'C:\\ws',
    openFile: () => Promise.resolve(),
    postMessage: () => undefined,
  };
  return { state, handlers: createWorkflowCommandHandlers(ctx), core, executed, seenExplainArgs };
}

function modelOf(state: ExtensionState) {
  return buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: 'C:\\ws' });
}

beforeEach(() => {
  __reset();
});

describe('AI explanation success', () => {
  it('should store the explanation against the deterministic plan ids', async () => {
    const h = harness();
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    await h.handlers['workflow.generatePlan']?.();
    const explanation = h.state.getAIExplanation();
    expect(explanation?.planId).toBe('plan-1');
    expect(explanation?.actions.map((a) => a.actionId)).toEqual(['a1', 'a2']);
    expect(explanation?.summary).toContain('missing dependencies');
  });

  it('should render the explanation below the repair plan with no commands', async () => {
    const h = harness();
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    await h.handlers['workflow.generatePlan']?.();
    const html = renderWorkflowHtml(modelOf(h.state));
    const planIndex = html.indexOf('Repair Plan');
    const explanationIndex = html.indexOf('AI Explanation');
    expect(planIndex).toBeGreaterThanOrEqual(0);
    expect(explanationIndex).toBeGreaterThan(planIndex);
    expect(html).toContain('What ResolveIt will do');
    expect(html).toContain('Run the safe installer.');
    const explanationSection = html.slice(explanationIndex);
    expect(explanationSection).not.toContain('data-command');
  });

  it('should pass the deterministic plan and diagnostics to the explainer', async () => {
    const h = harness();
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    h.state.setDiagnostics([{ id: 'd1' } as Diagnostic]);
    await h.handlers['workflow.generatePlan']?.();
    const args = h.seenExplainArgs[0] as [string, unknown, RepairPlan, unknown[], string];
    expect(args[0]).toBe('C:\\ws');
    expect((args[2] as RepairPlan).id).toBe('plan-1');
    expect((args[2] as RepairPlan).actions.map((a) => a.id)).toEqual(['a1', 'a2']);
  });
});

describe('AI unavailable', () => {
  it('should keep the plan and approval controls usable with a notice', async () => {
    const h = harness(async () => ({ status: 'unavailable', reason: 'AI is off.' }));
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    await h.handlers['workflow.generatePlan']?.();
    expect(h.state.getRepairPlan()?.actions).toHaveLength(2);
    expect(h.state.getAIExplanation()).toBeUndefined();
    const html = renderWorkflowHtml(modelOf(h.state));
    expect(html).toContain('AI Explanation');
    expect(html).toContain('AI explanation unavailable');
    expect(html).toContain('The repair plan above is still available');
    expect(html).toContain('data-command="workflow.approveAll"');
    expect(html).toContain('data-command="workflow.apply"');
    await h.handlers['workflow.approveAll']?.();
    await h.handlers['workflow.apply']?.();
    expect(h.executed).toEqual([['a1', 'a2']]);
  });
});

describe('AI failure', () => {
  it('should survive a throwing explainer with the plan intact', async () => {
    const h = harness(async () => {
      throw new Error('boom');
    });
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    await h.handlers['workflow.generatePlan']?.();
    const plan = h.state.getRepairPlan();
    expect(plan).toBeDefined();
    expect(plan?.actions.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(h.state.getAIExplanation()).toBeUndefined();
    const html = renderWorkflowHtml(modelOf(h.state));
    expect(html).toContain('AI explanation unavailable');
    expect(html).toContain('data-command="workflow.apply"');
  });
});

describe('explanation action integrity', () => {
  it('should never let an explanation create, rename, approve, or execute actions', async () => {
    const h = harness(async () => ({
      status: 'ready',
      explanation: {
        summary: 'Evil explanation.',
        actions: [
          {
            actionId: 'a-evil',
            title: 'evil',
            whatItMeans: 'x',
            whyDetected: 'x',
            whatResolveItWillDo: 'rm -rf /',
            expectedResult: 'x',
          },
        ],
      },
    }));
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    await h.handlers['workflow.generatePlan']?.();
    // Unknown action ids must not reach state: the model reports unavailable.
    expect(h.state.getAIExplanation()).toBeUndefined();
    expect(modelOf(h.state).aiExplanation.status).toBe('unavailable');
    expect(h.state.getRepairPlan()?.actions.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(h.state.getApproval('a1')).toBe('awaiting');
    expect(h.state.getExecution()).toBeUndefined();
    expect(h.executed).toEqual([]);
  });

  it('should escape explanation content instead of rendering it as markup', async () => {
    const h = harness(async () => ({
      status: 'ready',
      explanation: {
        summary: 'Fixes <script>alert(1)</script> the problem.',
        actions: [
          {
            actionId: 'a1',
            title: '<b>express</b>',
            whatItMeans: 'Means <img src=x onerror=1>.',
            whyDetected: 'Detected.',
            whatResolveItWillDo: 'Installs it.',
            expectedResult: 'Fixed.',
          },
          {
            actionId: 'a2',
            title: 'lodash',
            whatItMeans: 'Utilities.',
            whyDetected: 'Detected.',
            whatResolveItWillDo: 'Installs it.',
            expectedResult: 'Fixed.',
          },
        ],
      },
    }));
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    await h.handlers['workflow.generatePlan']?.();
    const html = renderWorkflowHtml(modelOf(h.state));
    expect(html).toContain('AI Explanation');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('should ignore explanations stored against a different plan id', () => {
    const h = harness();
    h.state.bindWorkspace('C:\\ws');
    h.state.markScanned();
    h.state.setRepairPlan(makePlan());
    h.state.setAIExplanation('other-plan', { summary: 'stale', actions: [] });
    expect(h.state.getAIExplanation()).toBeUndefined();
    expect(modelOf(h.state).aiExplanation.status).toBe('idle');
  });
});
