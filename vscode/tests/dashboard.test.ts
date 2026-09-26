import { describe, it, expect, beforeEach } from 'vitest';
import { __reset } from './vscode-mock.js';
import { ExtensionState } from '../src/state.js';
import { buildDashboardModel, type DashboardSnapshot } from '../src/dashboard/model.js';
import { snapshotFromState } from '../src/dashboard/snapshot.js';
import {
  filterExecutableIds,
  isDirectlyExecutable,
  isKnownActionType,
  lifecycleLabel,
  riskLabel,
  scopeLabel,
  toAIReport,
  toRepairCard,
} from '../src/dashboard/cards.js';
import { validateDashboardMessage } from '../src/dashboard/messages.js';
import { escapeHtml, renderDashboardBody } from '../src/dashboard/render.js';
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

function baseSnapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
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

function repairAction(overrides: Partial<RepairAction> = {}): RepairAction {
  return {
    id: 'action-1',
    type: 'install-dependency',
    permissionLevel: 'project-modification',
    description: 'Install cryptography into the project Python environment.',
    target: { projectId: 'p' },
    parameters: { name: 'cryptography', sourceFile: 'requirements.txt' },
    affectedFiles: ['requirements.txt'],
    reversible: false,
    estimatedImpact: 'Adds cryptography to the project environment.',
    riskLevel: 'project-modification',
    prerequisites: [],
    ...overrides,
  };
}

function repairPlan(ids: string[]): RepairPlan {
  return {
    id: 'plan-1',
    name: 'Repair plan',
    description: 'Install 2 missing dependencies.',
    actions: ids.map((id, index) =>
      repairAction({ id, description: `Install ${id}`, parameters: { name: id, sourceFile: 'requirements.txt' }, target: { projectId: `p${index}` } })
    ),
    requiresApproval: true,
  } as RepairPlan;
}

describe('dashboard state mapping', () => {
  it('should show NOT_SCANNED before any analysis', () => {
    const model = buildDashboardModel(baseSnapshot());
    expect(model.kind).toBe('NOT_SCANNED');
    expect(model.primary?.label).toBe('Analyze Project');
    expect(model.primary?.command).toBe('resolveit.analyzeProject');
    expect(model.primary?.enabled).toBe(true);
  });

  it('should disable analysis without a workspace', () => {
    const model = buildDashboardModel(baseSnapshot({ hasWorkspace: false }));
    expect(model.kind).toBe('NOT_SCANNED');
    expect(model.primary?.enabled).toBe(false);
    expect(model.description).toContain('Open a folder');
  });

  it('should show ANALYZING with progress and no duplicate actions', () => {
    const model = buildDashboardModel(
      baseSnapshot({ activeOperation: { kind: 'diagnose', activity: 'Running diagnostics…' } })
    );
    expect(model.kind).toBe('ANALYZING');
    expect(model.primary).toBeUndefined();
    expect(model.showProgress).toBe(true);
    expect(model.progressMessage).toBe('Running diagnostics…');
  });

  it('should show HEALTHY without confusing repair controls', () => {
    const model = buildDashboardModel(baseSnapshot({ hasScanned: true }));
    expect(model.kind).toBe('HEALTHY');
    expect(model.title).toContain('healthy');
    expect(model.primary?.command).toBe('resolveit.analyzeProject');
  });

  it('should show PROBLEMS_FOUND when AI is unavailable', () => {
    const model = buildDashboardModel(
      baseSnapshot({ hasScanned: true, diagnostics: [diagnostic()], blockingCount: 1, aiAvailable: false })
    );
    expect(model.kind).toBe('PROBLEMS_FOUND');
    expect(model.primary?.label).toBe('Review Problems');
    expect(model.description).toContain('Deterministic');
  });

  it('should show AI_ANALYSIS_AVAILABLE when AI can plan', () => {
    const model = buildDashboardModel(
      baseSnapshot({
        hasScanned: true,
        diagnostics: [diagnostic()],
        blockingCount: 1,
        aiAvailable: true,
        aiProvider: 'local',
        aiModel: 'gemma3:4b',
      })
    );
    expect(model.kind).toBe('AI_ANALYSIS_AVAILABLE');
    expect(model.primary?.label).toBe('Generate Repair Plan');
    expect(model.primary?.command).toBe('resolveit.generateRepairPlan');
  });

  it('should move through REPAIR_PLAN_READY, AWAITING_APPROVAL, and APPROVED', () => {
    const ready = buildDashboardModel(
      baseSnapshot({ hasScanned: true, hasPlan: true, planActionCount: 2, planDecidedCount: 0, planApprovedCount: 0 })
    );
    expect(ready.kind).toBe('REPAIR_PLAN_READY');
    expect(ready.primary?.label).toBe('Review Repairs');

    const awaiting = buildDashboardModel(
      baseSnapshot({ hasScanned: true, hasPlan: true, planActionCount: 2, planDecidedCount: 1, planApprovedCount: 1 })
    );
    expect(awaiting.kind).toBe('AWAITING_APPROVAL');
    expect(awaiting.primary?.label).toBe('Apply Approved Repairs');
    expect(awaiting.primary?.enabled).toBe(true);

    const undecided = buildDashboardModel(
      baseSnapshot({ hasScanned: true, hasPlan: true, planActionCount: 2, planDecidedCount: 1, planApprovedCount: 0 })
    );
    expect(undecided.kind).toBe('AWAITING_APPROVAL');
    expect(undecided.primary?.enabled).toBe(false);

    const approved = buildDashboardModel(
      baseSnapshot({ hasScanned: true, hasPlan: true, planActionCount: 2, planDecidedCount: 2, planApprovedCount: 2 })
    );
    expect(approved.kind).toBe('APPROVED');
    expect(approved.primary?.command).toBe('resolveit.applyApprovedRepairs');
  });

  it('should show APPLYING and VERIFICATION without duplicate Apply buttons', () => {
    const applying = buildDashboardModel(
      baseSnapshot({ hasScanned: true, hasPlan: true, activeOperation: { kind: 'repair', activity: 'Applying approved repairs…' } })
    );
    expect(applying.kind).toBe('APPLYING');
    expect(applying.primary).toBeUndefined();
    expect(applying.showProgress).toBe(true);

    const verifying = buildDashboardModel(
      baseSnapshot({ hasScanned: true, activeOperation: { kind: 'verify', activity: 'Verifying changes…' } })
    );
    expect(verifying.kind).toBe('VERIFICATION');
    expect(verifying.primary).toBeUndefined();
  });

  it('should show RESOLVED only after verification', () => {
    const model = buildDashboardModel(
      baseSnapshot({ hasScanned: true, hasVerification: true, verificationResolved: 2, verificationRemaining: 0 })
    );
    expect(model.kind).toBe('RESOLVED');
    expect(model.primary?.label).toBe('Verify Again');
  });

  it('should show PARTIALLY_RESOLVED with remaining work', () => {
    const model = buildDashboardModel(
      baseSnapshot({ hasScanned: true, hasVerification: true, verificationResolved: 1, verificationRemaining: 2 })
    );
    expect(model.kind).toBe('PARTIALLY_RESOLVED');
    expect(model.primary?.label).toBe('Review Problems');
    expect(model.description).toContain('1 resolved');
  });

  it('should show FAILED with a useful next action', () => {
    const failed = buildDashboardModel(baseSnapshot({ hasScanned: true, errorMessage: 'Install cryptography failed.' }));
    expect(failed.kind).toBe('FAILED');
    expect(failed.description).toBe('Install cryptography failed.');
    expect(failed.description).not.toContain('Something went wrong');
    expect(failed.primary?.label).toBe('Try Again');

    const executionFailed = buildDashboardModel(
      baseSnapshot({ hasScanned: true, hasExecution: true, executionSucceeded: 1, executionFailed: 1 })
    );
    expect(executionFailed.kind).toBe('FAILED');
  });

  it('should count severities for the status grid', () => {
    const model = buildDashboardModel(
      baseSnapshot({
        hasScanned: true,
        diagnostics: [diagnostic(), diagnostic({ id: 'd2', severity: 'warning' }), diagnostic({ id: 'd3', severity: 'critical' })],
        blockingCount: 2,
        requirementsCount: 5,
      })
    );
    expect(model.counts.total).toBe(3);
    expect(model.counts.errors).toBe(2);
    expect(model.counts.warnings).toBe(1);
    expect(model.counts.requirements).toBe(5);
  });
});

describe('extension state plan tracking', () => {
  it('should track approvals and protect against stale plans', () => {
    const state = new ExtensionState();
    state.bindWorkspace('/ws');
    state.setDiagnostics([diagnostic()]);
    state.setRepairPlan(repairPlan(['a', 'b']));
    expect(state.isPlanStale()).toBe(false);
    state.setApproval('a', true);
    state.setApproval('b', false);
    expect(state.getApprovedIds()).toEqual(['a']);
    expect(state.getDecidedCount()).toBe(2);
    expect(state.isPlanStale()).toBe(false);
    state.setDiagnostics([diagnostic(), diagnostic({ id: 'd2' })]);
    expect(state.isPlanStale()).toBe(true);
  });

  it('should clear plan state on workspace switching', () => {
    const state = new ExtensionState();
    state.bindWorkspace('/a');
    state.setDiagnostics([diagnostic()]);
    state.markScanned();
    state.setRepairPlan(repairPlan(['a']));
    state.setApproval('a', true);
    state.bindWorkspace('/b');
    expect(state.getRepairPlan()).toBeUndefined();
    expect(state.getApprovedIds()).toEqual([]);
    expect(state.getHasScanned()).toBe(false);
    expect(state.isPlanStale()).toBe(false);
  });

  it('should build snapshots from real state', () => {
    const state = new ExtensionState();
    state.bindWorkspace('/ws');
    let snapshot = snapshotFromState(state, { hasWorkspace: true, workspaceName: 'ws' });
    expect(buildDashboardModel(snapshot).kind).toBe('NOT_SCANNED');
    state.markScanned();
    state.setDiagnostics([diagnostic()]);
    state.setAIStatus({ provider: 'local', model: 'gemma3:4b', baseUrl: 'http://localhost:11434', available: true });
    snapshot = snapshotFromState(state, { hasWorkspace: true, workspaceName: 'ws' });
    const model = buildDashboardModel(snapshot);
    expect(model.kind).toBe('AI_ANALYSIS_AVAILABLE');
    expect(snapshot.aiModel).toBe('gemma3:4b');
  });
});

describe('repair cards and AI report', () => {
  it('should map the full repair lifecycle without implying unverified success', () => {
    expect(toRepairCard(repairAction(), 'awaiting').lifecycle).toBe('awaiting-approval');
    expect(toRepairCard(repairAction(), 'approved').lifecycle).toBe('approved');
    expect(toRepairCard(repairAction(), 'denied').lifecycle).toBe('denied');
    const executed = toRepairCard(repairAction(), 'approved', { result: { success: true }, verified: false, executing: false });
    expect(executed.lifecycle).toBe('executed');
    expect(executed.lifecycle).not.toBe('verified');
    const verified = toRepairCard(repairAction(), 'approved', { result: { success: true }, verified: true, executing: false });
    expect(verified.lifecycle).toBe('verified');
    const failed = toRepairCard(repairAction(), 'approved', { result: { success: false, error: 'pip failed' }, verified: false, executing: false });
    expect(failed.lifecycle).toBe('failed');
    expect(failed.executionError).toBe('pip failed');
    expect(lifecycleLabel('awaiting-approval')).toBe('Awaiting approval');
  });

  it('should describe scope and risk factually', () => {
    expect(scopeLabel('project-modification')).toBe('Project change');
    expect(scopeLabel('system-modification')).toBe('System change');
    expect(scopeLabel('read-only')).toBe('Read only');
    expect(riskLabel('project-modification')).toBe('Project environment');
    const card = toRepairCard(repairAction(), 'awaiting');
    expect(card.scope).toBe('Project change');
    expect(card.target).toContain('cryptography');
    expect(card.reason).toContain('Adds cryptography');
  });

  it('should summarize AI proposals as unvalidated', () => {
    const report = toAIReport({
      provider: 'local',
      model: 'gemma3:4b',
      result: {
        summary: 'Found 2 repairable issues.',
        actions: [
          { type: 'install-dependency', parameters: { name: 'cryptography' }, rationale: 'Required by requirements.txt' },
          { type: 'run-script', parameters: { command: 'rm -rf /' } },
        ],
      },
      approvedCount: 0,
      executedCount: 0,
      verifiedCount: 0,
    });
    expect(report.detected).toBe(2);
    expect(report.proposed).toBe(2);
    expect(report.cards[0]?.source).toContain('unvalidated');
    expect(report.cards[0]?.lifecycle).toBe('proposed');
  });

  it('should never let dangerous or untrusted AI actions become directly executable', () => {
    const cards = [
      toRepairCard(repairAction({ id: 'good', type: 'install-dependency' }), 'approved'),
      toRepairCard(repairAction({ id: 'evil', type: 'run-script' }), 'approved'),
    ];
    for (const card of cards) {
      expect(isDirectlyExecutable(card)).toBe(false);
    }
    expect(isKnownActionType('run-script')).toBe(true);
    expect(isKnownActionType('delete-everything')).toBe(false);
    const unknown = toRepairCard(repairAction({ id: 'x', type: 'delete-everything' }), 'approved');
    expect(filterExecutableIds([unknown], ['x'])).toEqual([]);
    expect(filterExecutableIds(cards, ['good', 'evil', 'missing'])).toEqual(['good', 'evil']);
    expect(filterExecutableIds(cards, [])).toEqual([]);
  });
});

describe('webview message validation', () => {
  it('should accept allowlisted commands', () => {
    expect(validateDashboardMessage({ type: 'command', command: 'resolveit.analyzeProject' })).toEqual({
      command: 'resolveit.analyzeProject',
    });
    expect(
      validateDashboardMessage({ type: 'command', command: 'resolveit.approveAction', actionId: 'action-1' })
    ).toEqual({ command: 'resolveit.approveAction', actionId: 'action-1' });
  });

  it('should reject unknown commands and malformed messages', () => {
    expect(validateDashboardMessage(undefined)).toBeUndefined();
    expect(validateDashboardMessage('resolveit.analyzeProject')).toBeUndefined();
    expect(validateDashboardMessage({ type: 'command', command: 'workbench.action.openSettings' })).toBeUndefined();
    expect(validateDashboardMessage({ type: 'command', command: 'vscode.open' })).toBeUndefined();
    expect(validateDashboardMessage({ type: 'render', html: '<script>evil()</script>' })).toBeUndefined();
    expect(validateDashboardMessage({ type: 'command' })).toBeUndefined();
  });

  it('should require safe action ids for approval commands', () => {
    expect(validateDashboardMessage({ type: 'command', command: 'resolveit.approveAction' })).toBeUndefined();
    expect(validateDashboardMessage({ type: 'command', command: 'resolveit.skipAction', actionId: '' })).toBeUndefined();
    expect(
      validateDashboardMessage({ type: 'command', command: 'resolveit.approveAction', actionId: '../../etc/passwd; rm -rf' })
    ).toBeUndefined();
    expect(
      validateDashboardMessage({ type: 'command', command: 'resolveit.skipAction', actionId: 'a'.repeat(300) })
    ).toBeUndefined();
  });
});

describe('dashboard rendering', () => {
  function renderable(overrides: Partial<DashboardSnapshot> = {}) {
    const snapshot = baseSnapshot({ hasScanned: true, ...overrides });
    return {
      model: buildDashboardModel(snapshot),
      workspaceName: 'demo',
      multiRoot: false,
      ai: undefined as { provider: string; model: string; available: boolean } | undefined,
      aiSummary: undefined as string | undefined,
      cards: [] as ReturnType<typeof toRepairCard>[],
      verification: undefined as { resolved: number; remaining: number } | undefined,
      execution: undefined as { succeeded: number; failed: number } | undefined,
      environmentReady: undefined as boolean | undefined,
    };
  }

  it('should escape untrusted text', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(escapeHtml('<script>alert("x")</script>')).not.toContain('<script>');
    const input = renderable();
    const html = renderDashboardBody({ ...input, workspaceName: '<img src=x onerror=evil()>' });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('should render the primary action and empty states', () => {
    const html = renderDashboardBody(renderable());
    expect(html).toContain('Analyze Project');
    expect(html).toContain('data-command="resolveit.analyzeProject"');
    expect(html).toContain('Project looks healthy');
  });

  it('should render approval cards with explicit states', () => {
    const plan = repairPlan(['a', 'b']);
    const input = renderable({ hasPlan: true, planActionCount: 2 });
    const html = renderDashboardBody({
      ...input,
      model: buildDashboardModel(baseSnapshot({ hasScanned: true, hasPlan: true, planActionCount: 2 })),
      cards: [toRepairCard(plan.actions[0] as RepairAction, 'approved'), toRepairCard(plan.actions[1] as RepairAction, 'awaiting')],
    });
    expect(html).toContain('Allow');
    expect(html).toContain('Skip');
    expect(html).toContain('Approved');
    expect(html).toContain('Awaiting approval');
    expect(html).toContain('data-action-id="a"');
    expect(html).not.toMatch(/>\s*Safe\s*</);
  });

  it('should never claim fixed without verification', () => {
    const plan = repairPlan(['a']);
    const executed = toRepairCard(plan.actions[0] as RepairAction, 'approved', {
      result: { success: true },
      verified: false,
      executing: false,
    });
    const html = renderDashboardBody({
      ...renderable({ hasPlan: true, planActionCount: 1 }),
      cards: [executed],
    });
    expect(html).toContain('Executed');
    expect(html).not.toContain('Verified');
    expect(html.toLowerCase()).not.toContain('fixed');
  });

  it('should explain AI status without secrets', () => {
    const unavailable = renderDashboardBody({
      ...renderable({ aiAvailable: false }),
      ai: { provider: 'local', model: 'gemma3:4b', available: false },
    });
    expect(unavailable).toContain('Unavailable');
    expect(unavailable).toContain('deterministic');

    const none = renderDashboardBody({ ...renderable(), ai: undefined });
    expect(none).toContain('Not configured');
    expect(none).not.toMatch(/api[_-]?key/i);
  });
});
