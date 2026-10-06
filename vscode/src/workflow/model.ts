import * as vscode from 'vscode';
import type { ExtensionState } from '../state.js';
import type { AIConfig, RepairAction, RepairPlan } from '../../../src/index.js';

export type WorkflowStep = 
  | 'ai-mode'
  | 'project'
  | 'analyze'
  | 'status'
  | 'repair-plan'
  | 'apply'
  | 'verify'
  | 'success'
  | 'failed';

export const WORKFLOW_STEP_ORDER: ReadonlyArray<WorkflowStep> = [
  'ai-mode',
  'project',
  'analyze',
  'status',
  'repair-plan',
  'apply',
  'verify',
  'success',
  'failed',
];

export function isWorkflowStep(value: string): value is WorkflowStep {
  return (WORKFLOW_STEP_ORDER as ReadonlyArray<string>).includes(value);
}

/**
 * Per-action presentation state. These are mutually exclusive by construction so
 * the UI can never show a contradictory combination such as
 * "Failed" together with "Awaiting approval".
 */
export type ActionLifecycle =
  | 'awaiting-approval'
  | 'approved'
  | 'denied'
  | 'executed'
  | 'failed'
  | 'verified';

export interface ActionView {
  readonly action: RepairAction;
  readonly lifecycle: ActionLifecycle;
  readonly label: string;
  readonly detail?: string;
  readonly approvable: boolean;
  readonly applied: boolean;
  readonly succeeded?: boolean;
}

function stepIndex(step: WorkflowStep): number {
  return WORKFLOW_STEP_ORDER.indexOf(step);
}

export function adjacentStep(step: WorkflowStep, direction: 'forward' | 'back'): WorkflowStep | undefined {
  const index = stepIndex(step);
  const next = direction === 'forward' ? index + 1 : index - 1;
  if (next < 0 || next >= WORKFLOW_STEP_ORDER.length) {
    return undefined;
  }
  // 'failed' is a terminal presentation, never part of linear navigation.
  if (WORKFLOW_STEP_ORDER[next] === 'failed') {
    return undefined;
  }
  return WORKFLOW_STEP_ORDER[next];
}

export interface AIModeOption {
  readonly id: 'none' | 'local' | 'external';
  readonly label: string;
  readonly description: string;
  readonly available: boolean;
  readonly configured: boolean;
}

export interface WorkflowModel {
  readonly currentStep: WorkflowStep;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly workspaceName: string;
  readonly workspaceRoot: string;
  readonly aiMode: AIConfig['provider'];
  readonly aiModeOptions: AIModeOption[];
  readonly aiStatus: { available: boolean; provider: string; model: string; baseUrl: string } | undefined;
  readonly projectName: string;
  readonly projectRoot: string;
  readonly analyzeProgress: {
    readonly stage: string;
    readonly completed: boolean;
    /** True once the user has actually started analysis. */
    readonly started: boolean;
    readonly steps: ReadonlyArray<{ label: string; done: boolean; current: boolean }>;
  };
  readonly statusSummary: {
    readonly requirementsTotal: number;
    readonly issuesFound: number;
    readonly blockingIssues: number;
  };
  readonly repairPlan: {
    readonly plan: RepairPlan | undefined;
    /** True only when the current plan was produced by the AI planner. */
    readonly aiUsed: boolean;
    /** Provenance notes: fallbacks, Core rejections, manual-action items. */
    readonly notices: ReadonlyArray<string>;
    readonly approvedCount: number;
    readonly deniedCount: number;
    readonly pendingCount: number;
    /** Awaiting actions that are system-level and excluded from bulk approval. */
    readonly systemPendingCount: number;
    readonly totalCount: number;
    readonly actions: ReadonlyArray<ActionView>;
    readonly previousAttempt?: {
      readonly resolved: ReadonlyArray<string>;
      readonly remaining: ReadonlyArray<string>;
      readonly message: string;
    };
  };
  readonly applyProgress: {
    readonly completed: number;
    readonly total: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly actions: ReadonlyArray<{ label: string; status: 'pending' | 'running' | 'success' | 'failed'; error?: string }>;
  };
  readonly projectTest?: {
    readonly running: boolean;
    readonly commandLabel?: string;
    readonly attempted: boolean;
    readonly success: boolean;
    readonly exitCode: number;
    readonly output: string;
    readonly message: string;
  };
  /** Whether the analyze stage still has to run before Status is reachable. */
  readonly canLeaveAnalyze: boolean;
  readonly verifyResult: {
    readonly success: boolean;
    readonly resolved: number;
    readonly remaining: number;
    readonly details: string;
  };
  readonly errorMessage?: string;
}

function getAIModeOptions(aiConfig: AIConfig, aiStatus?: { available: boolean; provider: string; model: string; baseUrl: string }): AIModeOption[] {
  return [
    {
      id: 'none',
      label: 'No AI (Deterministic)',
      description: 'Use built-in diagnostic rules only. No external AI calls.',
      available: true,
      configured: true,
    },
    {
      id: 'local',
      label: 'Local AI (Ollama-compatible)',
      description: 'Use a local Ollama-compatible endpoint for AI-assisted planning.',
      available: aiStatus?.provider === 'local' || aiConfig.provider === 'local',
      configured: aiConfig.provider === 'local' && !!aiConfig.baseUrl,
    },
    {
      id: 'external',
      label: 'External AI (OpenAI-compatible)',
      description: 'Use an OpenAI-compatible API (OpenAI, Azure, etc.) for AI-assisted planning.',
      available: aiStatus?.provider === 'external' || aiConfig.provider === 'external',
      configured: aiConfig.provider === 'external' && !!aiConfig.baseUrl,
    },
  ];
}

function getAnalyzeProgress(state: ExtensionState): WorkflowModel['analyzeProgress'] {
  const activeOp = state.getActiveOperation();
  const isAnalyzing = activeOp?.kind === 'analyze';
  
  const steps = [
    { label: 'Project discovered', done: state.getHasScanned(), current: isAnalyzing && !state.getHasScanned() },
    { label: 'Requirements scanned', done: state.getRequirements().length > 0, current: isAnalyzing && state.getHasScanned() && state.getRequirements().length === 0 },
    { label: 'Environment inspected', done: !!state.getEnvironment(), current: isAnalyzing && state.getRequirements().length > 0 && !state.getEnvironment() },
    { label: 'Diagnostics generated', done: state.getDiagnostics().length > 0, current: isAnalyzing && !!state.getEnvironment() && state.getDiagnostics().length === 0 },
  ];

  return {
    stage: activeOp?.activity ?? 'Ready to analyze',
    completed: state.getHasScanned() && state.getDiagnostics().length > 0,
    started: isAnalyzing,
    steps,
  };
}

function getStatusSummary(state: ExtensionState): WorkflowModel['statusSummary'] {
  const diagnostics = state.getDiagnostics();
  const requirements = state.getRequirements().flatMap(r => r.requirements);
  const blocking = diagnostics.filter(d => d.severity === 'error' || d.severity === 'critical').length;

  return {
    requirementsTotal: requirements.length,
    issuesFound: diagnostics.length,
    blockingIssues: blocking,
  };
}

const LIFECYCLE_LABELS: Readonly<Record<ActionLifecycle, string>> = {
  'awaiting-approval': 'Awaiting approval',
  approved: 'Approved',
  denied: 'Denied',
  executed: 'Executed',
  failed: 'Failed',
  verified: 'Verified',
};

/**
 * Resolve one action's lifecycle. Execution outcome wins over approval state so a
 * failed action can never fall back to "Awaiting approval", and `verified` is only
 * reachable once verification actually passed.
 */
export function resolveActionLifecycle(
  approval: 'awaiting' | 'approved' | 'denied',
  executed?: { success: boolean; error?: string },
  verified = false
): ActionLifecycle {
  if (executed) {
    if (!executed.success) {
      return 'failed';
    }
    return verified ? 'verified' : 'executed';
  }
  if (approval === 'approved') {
    return 'approved';
  }
  if (approval === 'denied') {
    return 'denied';
  }
  return 'awaiting-approval';
}

function getActionViews(state: ExtensionState, plan: RepairPlan, verified: boolean): ReadonlyArray<ActionView> {
  const execution = state.getExecution();
  return plan.actions.map((action) => {
    const approval = state.getApproval(action.id);
    const executed = execution?.results.find((entry) => entry.action.id === action.id)?.result;
    const lifecycle = resolveActionLifecycle(approval, executed, verified && executed?.success === true);
    const applied = executed !== undefined;
    return {
      action,
      lifecycle,
      label: LIFECYCLE_LABELS[lifecycle],
      ...(executed && executed.error ? { detail: executed.error } : {}),
      // Approval controls are only offered while the action is genuinely pending.
      approvable: !applied,
      applied,
      ...(executed ? { succeeded: executed.success } : {}),
    };
  });
}

function getRepairPlan(state: ExtensionState): WorkflowModel['repairPlan'] {
  const plan = state.getRepairPlan();
  if (!plan) {
    return {
      plan: undefined,
      aiUsed: false,
      notices: [],
      approvedCount: 0,
      deniedCount: 0,
      pendingCount: 0,
      systemPendingCount: 0,
      totalCount: 0,
      actions: [],
      previousAttempt: undefined,
    };
  }

  const verified = getVerifyResult(state).success;
  const actions = getActionViews(state, plan, verified);
  const approvedIds = new Set(state.getApprovedIds());

  return {
    plan,
    aiUsed: state.getRepairPlanAiUsed(),
    notices: state.getRepairPlanNotices(),
    approvedCount: approvedIds.size,
    deniedCount: actions.filter((view) => view.lifecycle === 'denied').length,
    pendingCount: actions.filter((view) => view.lifecycle === 'awaiting-approval').length,
    systemPendingCount: actions.filter(
      (view) =>
        view.lifecycle === 'awaiting-approval' &&
        (view.action.riskLevel === 'system-modification' || view.action.permissionLevel === 'system-modification')
    ).length,
    totalCount: plan.actions.length,
    actions,
    previousAttempt: state.getVerificationSummary(),
  };
}

function getApplyProgress(state: ExtensionState): WorkflowModel['applyProgress'] {
  const execution = state.getExecution();
  const plan = state.getRepairPlan();
  if (!execution || !plan) {
    return { completed: 0, total: 0, succeeded: 0, failed: 0, actions: [] };
  }

  const approvedIds = new Set(state.getApprovedIds());
  const approvedActions = plan.actions.filter(a => approvedIds.has(a.id));

  // Only approved actions are reported. Actions the user never approved are not
  // failures and must never be counted as such.
  const actions = approvedActions.map(action => {
    const result = execution.results.find(r => r.action.id === action.id);
    if (!result) return { label: action.description, status: 'pending' as const };
    return {
      label: action.description,
      status: result.result.success ? ('success' as const) : ('failed' as const),
      ...(result.result.error ? { error: result.result.error } : {}),
    };
  });

  return {
    completed: actions.filter(a => a.status === 'success' || a.status === 'failed').length,
    total: approvedActions.length,
    succeeded: actions.filter(a => a.status === 'success').length,
    failed: actions.filter(a => a.status === 'failed').length,
    actions,
  };
}

function getVerifyResult(state: ExtensionState): WorkflowModel['verifyResult'] {
  const verification = state.getLastVerification();
  if (!verification) {
    return { success: false, resolved: 0, remaining: 0, details: 'Not verified yet' };
  }

  return {
    success: verification.remaining.length === 0,
    resolved: verification.resolved.length,
    remaining: verification.remaining.length,
    details: verification.remaining.length === 0
      ? `All ${verification.resolved.length} blocking issues resolved`
      : `${verification.resolved.length} resolved, ${verification.remaining.length} remain`,
  };
}

export interface WorkflowModelInput {
  readonly hasWorkspace: boolean;
  readonly workspaceName: string;
  readonly workspaceRoot: string;
  /** Stage the user is currently viewing, when they are navigating manually. */
  readonly requestedStep?: WorkflowStep;
}

/**
 * Resolve which stage to display.
 *
 * Once analysis has produced results the screen is driven by real state, so the
 * panel can never claim progress the Core has not made. Before any work has been
 * done the user is free to sit on an earlier stage (AI Mode / Project / Analyze),
 * which is what makes AI Mode the actual first screen of the workflow.
 */
export function resolveCurrentStep(state: ExtensionState, input: WorkflowModelInput): WorkflowStep {
  const hasResults =
    state.getHasScanned() ||
    state.getRepairPlan() !== undefined ||
    state.getExecution() !== undefined ||
    state.getLastVerification() !== undefined;

  const derived = deriveStep(state, input.hasWorkspace);

  if (!hasResults && input.requestedStep !== undefined) {
    const requested = input.requestedStep;
    // Only pre-analysis stages may be selected freely.
    if (requested === 'ai-mode' || requested === 'project' || requested === 'analyze') {
      if (requested === 'analyze' && !input.hasWorkspace) {
        return 'project';
      }
      return requested;
    }
  }

  return derived;
}

function deriveStep(state: ExtensionState, hasWorkspace: boolean): WorkflowStep {
  const hasPlan = state.getRepairPlan() !== undefined;
  const hasExecution = state.getExecution() !== undefined;
  const hasVerification = state.getLastVerification() !== undefined;
  const hasError = state.getLastError() !== undefined;
  const hasScanned = state.getHasScanned();

  if (hasError && !hasVerification) {
    return 'failed';
  }
  if (hasVerification) {
    const result = getVerifyResult(state);
    return result.success ? 'success' : 'failed';
  }
  if (hasExecution) {
    return 'apply';
  }
  if (hasPlan) {
    return 'repair-plan';
  }
  if (hasScanned) {
    // Both problematic and healthy projects land on Status: it shows the
    // summary either way, and Success is reserved for actual verification.
    return 'status';
  }
  return hasWorkspace ? 'analyze' : 'project';
}

export function buildWorkflowModel(state: ExtensionState, input: WorkflowModelInput): WorkflowModel {
  const aiConfig = {
    provider: vscode.workspace.getConfiguration('resolveit').get('ai.provider', 'none') as 'none' | 'local' | 'external',
    model: vscode.workspace.getConfiguration('resolveit').get('ai.model', ''),
    baseUrl: vscode.workspace.getConfiguration('resolveit').get('ai.baseUrl', ''),
    timeoutMs: vscode.workspace.getConfiguration('resolveit').get('ai.timeout', 30000),
  };

  const aiStatus = state.getAIStatus();
  const aiModeOptions = getAIModeOptions(aiConfig, aiStatus ? { available: aiStatus.available, provider: aiStatus.provider, model: aiStatus.model, baseUrl: aiStatus.baseUrl } : undefined);
  
  const projectName = state.getProjectName() ?? '(no project detected)';
  const projectRoot = input.workspaceRoot;

  const currentStep = resolveCurrentStep(state, input);

  const analyzeProgress = getAnalyzeProgress(state);
  const statusSummary = getStatusSummary(state);
  const repairPlan = getRepairPlan(state);
  const applyProgress = getApplyProgress(state);
  const verifyResult = getVerifyResult(state);

  // Back/forward navigation is meaningful across the whole linear workflow.
  const canGoBack = currentStep !== 'failed' && adjacentStep(currentStep, 'back') !== undefined;

  // Status is only reachable once analysis has actually produced diagnostics, so the
  // analyze stage must not offer a Next action that cannot legally fire. Without a
  // workspace there is nothing to advance into at all.
  const canLeaveAnalyze = state.getHasScanned();
  const canGoForward =
    input.hasWorkspace &&
    adjacentStep(currentStep, 'forward') !== undefined &&
    !(currentStep === 'analyze' && !canLeaveAnalyze);

  return {
    currentStep,
    canGoBack,
    canGoForward,
    canLeaveAnalyze,
    workspaceName: input.workspaceName,
    workspaceRoot: input.workspaceRoot,
    aiMode: aiConfig.provider,
    aiModeOptions,
    aiStatus: aiStatus ? { available: aiStatus.available, provider: aiStatus.provider, model: aiStatus.model, baseUrl: aiStatus.baseUrl } : undefined,
    projectName,
    projectRoot,
    analyzeProgress,
    statusSummary,
    repairPlan,
    applyProgress,
    verifyResult,
    projectTest: state.getProjectTest(),
    errorMessage: state.getLastError()?.message,
  };
}