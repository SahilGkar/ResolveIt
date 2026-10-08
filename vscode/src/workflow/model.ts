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



/**
 * What the UI may claim about a provider option. `available` is true only for
 * the deterministic path or a provider that was actually probed successfully;
 * merely selecting an option never makes it available.
 */
export type AIModeStatus = 'connected' | 'not-reachable' | 'not-configured' | 'not-checked';

export interface AIModeOption {
  readonly id: 'none' | 'local' | 'external';
  readonly label: string;
  readonly description: string;
  readonly status: AIModeStatus;
  readonly available: boolean;
  readonly configured: boolean;
}

export interface WorkflowModel {
  readonly currentStep: WorkflowStep;
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
    /** Informational findings (info/hint): inventory notes, not problems. */
    readonly infoFindings: number;
    /** Real issues: warning severity and above. */
    readonly issues: number;
    /** Blocking issues: error/critical. */
    readonly blockingIssues: number;
    /** Declared vs actually-installed project dependencies, from Core evidence. */
    readonly dependencies: {
      readonly required: number;
      readonly satisfied: number;
      readonly missing: number;
      readonly mismatched: number;
      readonly missingNames: ReadonlyArray<string>;
      readonly mismatchedNames: ReadonlyArray<string>;
    };
  };
  readonly repairPlan: {
    readonly plan: RepairPlan | undefined;
    /** Provenance notes: manual-action items needing attention. */
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
  /**
   * Read-only AI explanation of the current deterministic plan. Informational
   * only: it is rendered below the approval controls and can never create,
   * modify, approve, or execute repair actions.
   */
  readonly aiExplanation: {
    readonly status: 'ready' | 'unavailable' | 'idle';
    readonly summary?: string;
    readonly actions?: ReadonlyArray<{
      readonly actionId: string;
      readonly title: string;
      readonly whatItMeans: string;
      readonly whyDetected: string;
      readonly whatResolveItWillDo: string;
      readonly expectedResult: string;
      readonly notes?: string;
    }>;
    readonly generalNotes?: string;
    readonly reason?: string;
  };
  readonly applyProgress: {
    readonly completed: number;
    readonly total: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly actions: ReadonlyArray<{ label: string; status: 'pending' | 'running' | 'success' | 'failed'; error?: string }>;
  };
  readonly verifyResult: {
    readonly success: boolean;
    readonly resolved: number;
    readonly remaining: number;
    readonly details: string;
  };
  /** Every applicable failure category with its evidence. Empty when nothing failed. */
  readonly failures: ReadonlyArray<WorkflowFailure>;
  readonly errorMessage?: string;
}

export interface WorkflowFailure {
  readonly kind: 'execution' | 'verification';
  readonly title: string;
  readonly detail: string;
}

function getAIModeOptions(aiConfig: AIConfig, aiStatus?: { available: boolean; provider: string; model: string; baseUrl: string }): AIModeOption[] {
  const statusFor = (id: 'none' | 'local' | 'external'): AIModeStatus => {
    if (id === 'none') {
      return 'connected';
    }
    if (!aiStatus || aiStatus.provider !== id) {
      return aiConfig.provider === id ? 'not-checked' : 'not-configured';
    }
    return aiStatus.available ? 'connected' : 'not-reachable';
  };
  const option = (
    id: 'none' | 'local' | 'external',
    label: string,
    description: string,
    configured: boolean
  ): AIModeOption => {
    const status = statusFor(id);
    return { id, label, description, status, available: status === 'connected', configured };
  };
  return [
    option(
      'none',
      'No AI',
      'Use built-in diagnostic rules only. No external AI calls.',
      true
    ),
    option(
      'local',
      'Local AI',
      'Explain repair plans using a local AI endpoint.',
      aiConfig.provider === 'local' && !!aiConfig.baseUrl
    ),
    option(
      'external',
      'External',
      'Explain repair plans using an external AI service.',
      aiConfig.provider === 'external' && !!aiConfig.baseUrl
    ),
  ];
}

function getAnalyzeProgress(state: ExtensionState): WorkflowModel['analyzeProgress'] {
  const activeOp = state.getActiveOperation();
  const isAnalyzing = activeOp?.kind === 'analyze';
  
  const steps = [
    { label: 'Project discovered', done: state.getHasScanned(), current: isAnalyzing && !state.getHasScanned() },
    { label: 'Requirements scanned', done: state.getRequirements().length > 0, current: isAnalyzing && state.getHasScanned() && state.getRequirements().length === 0 },
    { label: 'Environment inspected', done: !!state.getEnvironment(), current: isAnalyzing && state.getRequirements().length > 0 && !state.getEnvironment() },
    { label: 'Problems found', done: state.getDiagnostics().length > 0, current: isAnalyzing && !!state.getEnvironment() && state.getDiagnostics().length === 0 },
  ];

  return {
    stage: activeOp?.activity ?? 'Ready to analyze',
    completed: state.getHasScanned() && state.getDiagnostics().length > 0,
    started: isAnalyzing,
    steps,
  };
}

function getDependencySummary(state: ExtensionState): WorkflowModel['statusSummary']['dependencies'] {
  const requirements = state.getRequirements().flatMap(r => r.requirements);
  // Declared requirements: direct package dependencies. Managed lockfile and
  // transitive entries are inventory, not requirements; optional entries are
  // never repair problems. Managed here mirrors the Core dependency rule so
  // the counts agree with the diagnostics the Core actually emits.
  const declared = requirements.filter(
    (req) =>
      req.type === 'package-dependency' &&
      req.origin !== 'lockfile' &&
      req.origin !== 'transitive' &&
      req.metadata?.['indirect'] !== true &&
      req.optional !== true
  );
  const diagnostics = state.getDiagnostics();
  const namesOf = (code: string): ReadonlyArray<string> => {
    const names: string[] = [];
    for (const diag of diagnostics) {
      if (diag.code !== code) {
        continue;
      }
      const label = diag.requirement
        ? `${diag.requirement.name}${diag.requirement.versionConstraint ? ` ${diag.requirement.versionConstraint}` : ''}`
        : diag.title;
      if (!names.includes(label)) {
        names.push(label);
      }
    }
    return names.slice(0, 10);
  };
  const missingNames = namesOf('DEPENDENCY_PACKAGE_MISSING');
  const mismatchedNames = namesOf('DEPENDENCY_PACKAGE_VERSION_MISMATCH');
  const missing = missingNames.length;
  const mismatched = mismatchedNames.length;
  return {
    required: declared.length,
    satisfied: Math.max(0, declared.length - missing - mismatched),
    missing,
    mismatched,
    missingNames,
    mismatchedNames,
  };
}

function getStatusSummary(state: ExtensionState): WorkflowModel['statusSummary'] {
  const diagnostics = state.getDiagnostics();
  const requirements = state.getRequirements().flatMap(r => r.requirements);
  const info = diagnostics.filter(d => d.severity === 'info' || d.severity === 'hint').length;
  const issues = diagnostics.filter(d => d.severity === 'warning' || d.severity === 'error' || d.severity === 'critical').length;
  const blocking = diagnostics.filter(d => d.severity === 'error' || d.severity === 'critical').length;

  return {
    requirementsTotal: requirements.length,
    infoFindings: info,
    issues,
    blockingIssues: blocking,
    dependencies: getDependencySummary(state),
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

/**
 * Resolve which stage to display from real Core results.
 *
 * Reachable stages:
 * - Healthy project: status → verify → success (Done)
 * - Unhealthy project: status → repair-plan → apply → verify → success (Done)
 * - Verification failure: verify/apply → failed → repair-plan → apply → verify
 * - Start Over: success/failed → ai-mode
 *
 * Application startup (dev/start scripts, localhost readiness) never gates any
 * transition: ResolveIt diagnoses and repairs projects; it does not launch apps.
 */
function deriveStep(state: ExtensionState, hasWorkspace: boolean): WorkflowStep {
  const hasPlan = state.getRepairPlan() !== undefined;
  const hasExecution = state.getExecution() !== undefined;
  const verification = state.getLastVerification();
  const hasError = state.getLastError() !== undefined;
  const hasScanned = state.getHasScanned();

  if (hasError && verification === undefined) {
    return 'failed';
  }
  if (verification !== undefined) {
    if (verification.remaining.length > 0) {
      return 'failed';
    }
    // A clean verification lands on the Verify stage, which explains what was
    // checked. The user finishes it explicitly, which derives Done (success).
    if (state.isWorkflowCompleted()) {
      return 'success';
    }
    return 'verify';
  }
  if (hasExecution) {
    return 'apply';
  }
  if (hasPlan) {
    return 'repair-plan';
  }
  if (hasScanned) {
    // Both problematic and healthy projects land on Status: it shows the
    // summary either way, and Done is reserved for a finished workflow.
    return 'status';
  }
  return hasWorkspace ? 'analyze' : 'project';
}

/**
 * Best available project display name. Prefers a detected project name, then
 * falls back to the workspace folder name (an open folder is always a valid
 * project context), and only then to a generic placeholder. Discovery
 * semantics are untouched; this is display-only.
 */
export function displayProjectName(detected: string | undefined, workspaceRoot: string): string {
  if (detected !== undefined && detected.trim() !== '' && detected !== '(no projects)') {
    return detected;
  }
  const segments = workspaceRoot.split(/[/\\]+/).filter((segment) => segment !== '');
  const last = segments[segments.length - 1];
  if (last !== undefined && last !== '') {
    return last;
  }
  return '(no project detected)';
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
  
  const projectName = displayProjectName(state.getProjectName(), input.workspaceRoot);
  const projectRoot = input.workspaceRoot;

  const currentStep = resolveCurrentStep(state, input);

  const analyzeProgress = getAnalyzeProgress(state);
  const statusSummary = getStatusSummary(state);
  const repairPlan = getRepairPlan(state);
  const applyProgress = getApplyProgress(state);
  const verifyResult = getVerifyResult(state);
  const failures = getFailures(state);
  const aiExplanation = getAIExplanation(state);

  return {
    currentStep,
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
    failures,
    aiExplanation,
    errorMessage: state.getLastError()?.message,
  };
}

/**
 * Surface the stored AI explanation only when it describes the plan the
 * model is showing. Otherwise report it as unavailable (plan changed or
 * never explained) or idle (no plan to explain).
 */
function getAIExplanation(state: ExtensionState): WorkflowModel['aiExplanation'] {
  const plan = state.getRepairPlan();
  if (!plan) {
    return { status: 'idle' };
  }
  const explanation = state.getAIExplanation();
  if (explanation) {
    return {
      status: 'ready',
      summary: explanation.summary,
      actions: [...explanation.actions],
      ...(explanation.generalNotes === undefined ? {} : { generalNotes: explanation.generalNotes }),
    };
  }
  const reason = state.getAIExplanationUnavailable();
  if (reason !== undefined) {
    return { status: 'unavailable', reason };
  }
  return { status: 'idle' };
}

/**
 * Every failure category that currently applies, each with its own evidence.
 * Categories are independent: an execution failure and a verification failure
 * are both listed rather than one hiding the other.
 */
function getFailures(state: ExtensionState): ReadonlyArray<WorkflowFailure> {
  const failures: WorkflowFailure[] = [];
  const execution = state.getExecution();
  const failedActions = (execution?.results ?? []).filter((entry) => !entry.result.success);
  if (failedActions.length > 0) {
    failures.push({
      kind: 'execution',
      title: 'Execution failure',
      detail: failedActions
        .map((entry) => `${entry.action.description} — ${entry.result.error ?? 'unknown error'}`)
        .join('; '),
    });
  }
  const verification = state.getLastVerification();
  if (verification && verification.remaining.length > 0) {
    failures.push({
      kind: 'verification',
      title: 'Verification failure',
      detail: `${verification.resolved.length} resolved, ${verification.remaining.length} blocking diagnostic(s) remain.`,
    });
  }
  return failures;
}