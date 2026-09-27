import { describe, it, expect, beforeEach } from 'vitest';
import { __reset } from './vscode-mock.js';
import { ExtensionState } from '../src/state.js';
import { buildHubModel, hubNodeById, type HubNodeId } from '../src/hub/model.js';
import { hubStyles, renderHubBody, type HubRenderInput } from '../src/hub/render.js';
import { snapshotFromState } from '../src/dashboard/snapshot.js';
import { toRepairCard } from '../src/dashboard/cards.js';
import { DASHBOARD_ALLOWED_COMMANDS, validateDashboardMessage } from '../src/dashboard/messages.js';
import { createCommandHandlers } from '../src/commands.js';
import type { DashboardSnapshot } from '../src/dashboard/model.js';
import type { Diagnostic, RepairAction, RepairPlan } from '../../src/index.js';

beforeEach(() => {
  __reset();
});

function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    id: 'diag-1',
    code: 'X',
    severity: 'error',
    category: 'dependency',
    title: 'Missing dependency',
    message: 'cryptography is required but not installed',
    evidence: [],
    source: 'dependency-resolver',
    timestamp: new Date(),
    metadata: {},
    ...overrides,
  };
}

function snap(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    hasWorkspace: true,
    workspaceName: 'demo',
    hasScanned: false,
    activeOperation: undefined,
    diagnostics: [],
    blockingCount: 0,
    requirementsCount: 0,
    environmentReady: undefined,
    aiAvailable: false,
    aiProvider: undefined,
    aiModel: undefined,
    hasPlan: false,
    planActionCount: 0,
    planDecidedCount: 0,
    planApprovedCount: 0,
    planStale: false,
    hasExecution: false,
    executionSucceeded: 0,
    executionFailed: 0,
    verificationResolved: 0,
    verificationRemaining: 0,
    hasVerification: false,
    lastRunStatus: undefined,
    errorMessage: undefined,
    ...overrides,
  };
}

function repairAction(id: string, name: string): RepairAction {
  return {
    id,
    type: 'install-dependency',
    permissionLevel: 'project-modification',
    description: `Install ${name} into the project environment.`,
    target: {},
    parameters: { name, sourceFile: 'requirements.txt' },
    affectedFiles: ['requirements.txt'],
    riskLevel: 'project-modification',
    prerequisites: [],
  };
}

function renderable(model: ReturnType<typeof buildHubModel>, overrides: Partial<HubRenderInput> = {}): HubRenderInput {
  return {
    model,
    workspaceName: 'demo',
    multiRoot: false,
    aiSummary: undefined,
    cards: [],
    canApply: false,
    applySub: 'Review each change first.',
    verification: undefined,
    ...overrides,
  };
}

function node(model: ReturnType<typeof buildHubModel>, id: HubNodeId) {
  const found = hubNodeById(model, id);
  expect(found).toBeDefined();
  return found!;
}

describe('hub nodes before analysis', () => {
  it('should offer Analyze first and disable the rest with reasons', () => {
    const model = buildHubModel(snap());
    expect(model.centerStatus).toBe('Ready to analyze');
    expect(model.statusKind).toBe('neutral');
    expect(node(model, 'analyze').enabled).toBe(true);
    expect(node(model, 'analyze').command).toBe('resolveit.analyzeProject');
    for (const id of ['diagnostics', 'ai-report', 'apply'] as const) {
      const n = node(model, id);
      expect(n.enabled).toBe(false);
      expect(n.disabledReason).toBeTruthy();
      expect(n.sub).toBeTruthy();
    }
    expect(node(model, 'diagnostics').disabledReason).toContain('Analyze');
  });

  it('should disable Analyze without a workspace', () => {
    const model = buildHubModel(snap({ hasWorkspace: false }));
    expect(model.centerStatus).toBe('No folder open');
    expect(node(model, 'analyze').enabled).toBe(false);
  });
});

describe('hub nodes after analysis', () => {
  it('should show diagnostic counts and AI availability', () => {
    const model = buildHubModel(
      snap({
        hasScanned: true,
        diagnostics: [diagnostic(), diagnostic({ id: 'd2' }), diagnostic({ id: 'd3', severity: 'warning' })],
        blockingCount: 2,
        requirementsCount: 5,
        aiAvailable: true,
        aiProvider: 'local',
        aiModel: 'gemma3:4b',
      })
    );
    expect(model.centerStatus).toContain('2 issue');
    expect(model.statusKind).toBe('warn');
    expect(node(model, 'analyze').badge).toBeUndefined();
    const diagnostics = node(model, 'diagnostics');
    expect(diagnostics.enabled).toBe(true);
    expect(diagnostics.badge).toBe('2');
    expect(diagnostics.command).toBe('resolveit.reviewProblems');
    const ai = node(model, 'ai-report');
    expect(ai.enabled).toBe(true);
    expect(ai.label).toBe('Prepare AI Report');
    expect(ai.command).toBe('resolveit.generateRepairPlan');
    expect(ai.sub).toContain('gemma3:4b');
    expect(node(model, 'apply').enabled).toBe(false);
  });

  it('should mark a clean analysis as healthy', () => {
    const model = buildHubModel(snap({ hasScanned: true }));
    expect(model.centerStatus).toBe('Project healthy');
    expect(model.statusKind).toBe('ok');
    expect(node(model, 'analyze').badge).toBe('✓');
    expect(node(model, 'diagnostics').badge).toBe('✓');
  });

  it('should explain AI unavailability without blocking the plan', () => {
    const model = buildHubModel(snap({ hasScanned: true, diagnostics: [diagnostic()], blockingCount: 1, aiAvailable: false }));
    const ai = node(model, 'ai-report');
    expect(ai.enabled).toBe(true);
    expect(ai.sub).toContain('AI unavailable');
    expect(model.aiAvailable).toBe(false);
  });
});

describe('hub report and approval states', () => {
  function planned(overrides: Partial<DashboardSnapshot> = {}) {
    return snap({
      hasScanned: true,
      diagnostics: [diagnostic()],
      blockingCount: 1,
      hasPlan: true,
      planActionCount: 2,
      aiAvailable: true,
      aiProvider: 'local',
      aiModel: 'gemma3:4b',
      ...overrides,
    });
  }

  it('should move from Prepare to Review AI Report', () => {
    const model = buildHubModel(planned({ planDecidedCount: 0, planApprovedCount: 0 }));
    expect(model.centerStatus).toBe('AI report ready');
    expect(model.hasReport).toBe(true);
    const ai = node(model, 'ai-report');
    expect(ai.label).toBe('Review AI Report');
    expect(ai.badge).toBe('Ready');
    expect(ai.screenTarget).toBe('report');
    expect(ai.command).toBeUndefined();
    expect(node(model, 'apply').enabled).toBe(false);
    expect(node(model, 'apply').disabledReason).toContain('Allow');
  });

  it('should enable Apply only after approval', () => {
    const model = buildHubModel(planned({ planDecidedCount: 2, planApprovedCount: 1 }));
    expect(model.centerStatus).toContain('1 change(s) approved');
    const apply = node(model, 'apply');
    expect(apply.enabled).toBe(true);
    expect(apply.command).toBe('resolveit.applyApprovedRepairs');
    expect(apply.badge).toBe('1');
    expect(model.reportCounts).toMatchObject({ detected: 2, proposed: 2, approved: 1 });
  });

  it('should keep denied approvals from enabling Apply', () => {
    const model = buildHubModel(planned({ planDecidedCount: 2, planApprovedCount: 0 }));
    expect(node(model, 'apply').enabled).toBe(false);
  });

  it('should reject stale plans', () => {
    const model = buildHubModel(planned({ planDecidedCount: 2, planApprovedCount: 2, planStale: true }));
    expect(model.centerStatus).toBe('Report is stale');
    expect(model.statusKind).toBe('warn');
    expect(model.reportStale).toBe(true);
    expect(node(model, 'apply').enabled).toBe(false);
    expect(node(model, 'apply').disabledReason).toContain('fresh');
  });
});

describe('hub working, resolved, and failed states', () => {
  it('should disable actions while busy with a progress message', () => {
    const model = buildHubModel(snap({ hasScanned: true, activeOperation: { kind: 'diagnose', activity: 'Running diagnostics…' } }));
    expect(model.busy).toBe(true);
    expect(model.progressMessage).toBe('Running diagnostics…');
    expect(model.statusKind).toBe('working');
    for (const n of model.nodes) {
      expect(n.enabled).toBe(false);
      expect(n.disabledReason).toContain('working');
    }
  });

  it('should show resolved only after verification', () => {
    const model = buildHubModel(snap({ hasScanned: true, hasVerification: true, verificationResolved: 2, verificationRemaining: 0 }));
    expect(model.centerStatus).toBe('Project resolved');
    expect(model.statusKind).toBe('ok');
  });

  it('should show partial resolution honestly', () => {
    const model = buildHubModel(snap({ hasScanned: true, hasVerification: true, verificationResolved: 1, verificationRemaining: 2 }));
    expect(model.centerStatus).toContain('1 resolved');
    expect(model.centerStatus).toContain('2 remain');
    expect(model.statusKind).toBe('warn');
  });

  it('should show failure with the real reason', () => {
    const model = buildHubModel(snap({ hasScanned: true, errorMessage: 'Install cryptography failed.' }));
    expect(model.centerStatus).toBe('Repair failed');
    expect(model.statusKind).toBe('err');
    expect(model.notice).toBe('Install cryptography failed.');
  });
});

describe('hub state transitions through real extension state', () => {
  it('should follow analyze, plan, approve, and workspace switching', () => {
    const state = new ExtensionState();
    state.bindWorkspace('/ws');
    let model = buildHubModel(snapshotFromState(state, { hasWorkspace: true, workspaceName: 'ws' }));
    expect(model.centerStatus).toBe('Ready to analyze');
    expect(node(model, 'diagnostics').enabled).toBe(false);

    state.markScanned();
    state.setDiagnostics([diagnostic()]);
    state.setAIStatus({ provider: 'local', model: 'gemma3:4b', baseUrl: 'http://x', available: true });
    model = buildHubModel(snapshotFromState(state, { hasWorkspace: true, workspaceName: 'ws' }));
    expect(node(model, 'ai-report').label).toBe('Prepare AI Report');

    const plan: RepairPlan = {
      id: 'plan-1',
      name: 'p',
      description: 'Install 2 deps.',
      actions: [repairAction('a', 'cryptography'), repairAction('b', 'pytest-cov')],
      requiresApproval: true,
    } as RepairPlan;
    state.setRepairPlan(plan, 'Install 2 deps.');
    state.setApproval('a', true);
    model = buildHubModel(snapshotFromState(state, { hasWorkspace: true, workspaceName: 'ws' }));
    expect(node(model, 'ai-report').label).toBe('Review AI Report');
    expect(node(model, 'apply').enabled).toBe(true);

    state.bindWorkspace('/other');
    model = buildHubModel(snapshotFromState(state, { hasWorkspace: true, workspaceName: 'other' }));
    expect(model.centerStatus).toBe('Ready to analyze');
    expect(model.hasReport).toBe(false);
  });
});

describe('hub rendering', () => {
  it('should render a collapsed control and a hidden radial hub', () => {
    const html = renderHubBody(renderable(buildHubModel(snap())));
    expect(html).toContain('hub-collapsed');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('hub-expanded');
    expect(html).toContain('hidden');
    expect(html).toContain('ResolveIt');
    expect(html).toContain('Analyze Project');
  });

  it('should keep the center visually dominant with four wired actions', () => {
    const html = renderHubBody(renderable(buildHubModel(snap({ hasScanned: true }))));
    expect(html).toContain('hub-center');
    expect(html).toContain('◆');
    expect(html).toContain('<svg class="wires"');
    expect(html).toContain('pos-top');
    expect(html).toContain('pos-left');
    expect(html).toContain('pos-right');
    expect(html).toContain('pos-bottom');
    expect(html).toContain('Diagnostics');
    expect(html).toContain('Prepare AI Report');
    expect(html).toContain('Apply Changes');
  });

  it('should use clear verbs, never vague ones', () => {
    const html = renderHubBody(renderable(buildHubModel(snap({ hasScanned: true }))));
    for (const good of ['Analyze Project', 'Diagnostics', 'Prepare AI Report', 'Apply Changes']) {
      expect(html).toContain(good);
    }
    expect(html).not.toMatch(/>\s*(Run|Execute|Process|Submit)\s*</);
  });

  it('should render the focused AI report with approval controls', () => {
    const cards = [
      toRepairCard(repairAction('a', 'cryptography'), 'approved'),
      toRepairCard(repairAction('b', 'pytest-cov'), 'awaiting'),
    ];
    const html = renderHubBody(
      renderable(buildHubModel(snap({ hasScanned: true, hasPlan: true, planActionCount: 2, planDecidedCount: 1, planApprovedCount: 1 })), {
        cards,
        canApply: true,
        applySub: '1 of 2 approved',
        aiSummary: 'Install 2 missing dependencies.',
      })
    );
    expect(html).toContain('AI Repair Report');
    expect(html).toContain('Detected 2');
    expect(html).toContain('Approved 1');
    expect(html).toContain('Verified 0');
    expect(html).toContain('Allow');
    expect(html).toContain('Skip');
    expect(html).toContain('Apply Approved Changes');
    expect(html).toContain('data-action-id="a"');
    expect(html).toContain('← Hub');
    expect(html).not.toMatch(/>\s*Safe\s*</);
  });

  it('should show the AI unavailable box with real alternatives', () => {
    const html = renderHubBody(
      renderable(buildHubModel(snap({ hasScanned: true, hasPlan: true, planActionCount: 1, aiAvailable: false })), {
        cards: [toRepairCard(repairAction('a', 'x'), 'awaiting')],
        canApply: false,
        applySub: 'Allow actions first.',
      })
    );
    expect(html).toContain('AI unavailable');
    expect(html).toContain('data-command="resolveit.retryAI"');
    expect(html).toContain('Continue Without AI');
  });

  it('should never claim verified without verification', () => {
    const html = renderHubBody(
      renderable(buildHubModel(snap({ hasScanned: true, hasPlan: true, planActionCount: 1 })), {
        cards: [toRepairCard(repairAction('a', 'x'), 'approved', { result: { success: true }, verified: false, executing: false })],
        canApply: true,
        applySub: '1 of 1 approved',
      })
    );
    expect(html).toContain('Executed');
    expect(html).not.toContain('Verified 1');
    expect(html.toLowerCase()).not.toContain('fixed');
  });

  it('should escape untrusted text everywhere', () => {
    const html = renderHubBody(renderable(buildHubModel(snap()), { cards: [] }), );
    expect(html).not.toContain('<script');
    const evil = renderHubBody({
      ...renderable(buildHubModel(snap({ hasScanned: true, errorMessage: '<img src=x onerror=1>' }))),
      workspaceName: '<b>evil</b>',
    });
    expect(evil).not.toContain('<img src=x');
    expect(evil).not.toContain('<b>evil</b>');
  });

  it('should respect VS Code themes with no hardcoded surfaces', () => {
    const css = hubStyles();
    expect(css).toContain('var(--vscode-');
    expect(css).not.toContain('background:white');
    expect(css).not.toContain('background:#fff');
    expect(css).toContain('prefers-reduced-motion');
    expect(css).toContain('focus-visible');
  });

  it('should be keyboard accessible', () => {
    const html = renderHubBody(renderable(buildHubModel(snap())));
    expect(html).toContain('<button');
    expect(html).toContain('aria-label');
    expect(html).toContain('aria-expanded');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="group"');
  });
});

describe('hub command routing', () => {
  function collectCommands(html: string): string[] {
    return [...html.matchAll(/data-command="([^"]+)"/g)].map((match) => match[1] as string);
  }

  it('should route every visible action to a real allowlisted command', () => {
    const states = [
      snap(),
      snap({ hasScanned: true, diagnostics: [diagnostic()], blockingCount: 1, aiAvailable: true, aiProvider: 'p', aiModel: 'm' }),
      snap({ hasScanned: true, hasPlan: true, planActionCount: 2, planDecidedCount: 2, planApprovedCount: 2 }),
      snap({ hasScanned: true, hasVerification: true, verificationResolved: 1, verificationRemaining: 0 }),
      snap({ hasScanned: true, errorMessage: 'boom' }),
    ];
    const seen = new Set<string>();
    for (const s of states) {
      const model = buildHubModel(s);
      const cards = model.hasReport ? [toRepairCard(repairAction('a', 'x'), 'awaiting')] : [];
      const html = renderHubBody(renderable(model, { cards, canApply: true, applySub: 'ok' }));
      for (const command of collectCommands(html)) {
        seen.add(command);
        expect(DASHBOARD_ALLOWED_COMMANDS.has(command)).toBe(true);
      }
    }
    expect(seen.has('resolveit.analyzeProject')).toBe(true);
    expect(seen.has('resolveit.generateRepairPlan')).toBe(true);
    expect(seen.has('resolveit.applyApprovedRepairs')).toBe(true);
  });

  it('should map hub commands onto registered handlers', () => {
    const handlers = createCommandHandlers({
      core: {},
      state: new ExtensionState(),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, show: () => undefined },
      messages: { info: () => undefined, warn: () => undefined, error: () => undefined },
      status: { showBusy: () => undefined, showIssues: () => undefined, showOk: () => undefined },
      dialogs: { showPlanMessage: () => Promise.resolve(), askAction: () => Promise.resolve(false) },
      coordinator: { run: (_k: never, _r: string, task: (t: never) => Promise<unknown>) => task({} as never) } as never,
      workspaces: { sync: () => ({ changed: false, root: '/ws' }), isCurrent: () => true } as never,
      refreshViews: () => undefined,
      getWorkspaceFolders: () => [],
      reportProgress: (_t, task) => task(() => undefined),
      reportCancellable: (_t, task) =>
        task(() => undefined, { isCancellationRequested: false, onCancellationRequested: () => undefined }),
      getAIConfig: () => ({ provider: 'none' }),
      getMaxIterations: () => 3,
      openFile: () => Promise.resolve(),
    } as never);
    for (const command of [
      'resolveit.analyzeProject',
      'resolveit.reviewProblems',
      'resolveit.generateRepairPlan',
      'resolveit.applyApprovedRepairs',
      'resolveit.approveAction',
      'resolveit.skipAction',
      'resolveit.retryAI',
      'resolveit.askAI',
    ]) {
      expect(typeof handlers[command]).toBe('function');
    }
  });

  it('should keep webview message validation strict', () => {
    expect(validateDashboardMessage({ type: 'command', command: 'resolveit.analyzeProject' })).toEqual({
      command: 'resolveit.analyzeProject',
    });
    expect(validateDashboardMessage({ type: 'command', command: 'resolveit.generateRepairPlan' })).toEqual({
      command: 'resolveit.generateRepairPlan',
    });
    expect(validateDashboardMessage({ type: 'screen', screen: 'report' })).toBeUndefined();
    expect(validateDashboardMessage({ type: 'command', command: 'workbench.action.openSettings' })).toBeUndefined();
    expect(validateDashboardMessage({ type: 'command', command: 'resolveit.approveAction', actionId: 'a; rm -rf' })).toBeUndefined();
  });
});
