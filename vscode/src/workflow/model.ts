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
    readonly steps: Array<{ label: string; done: boolean; current: boolean }>;
  };
  readonly statusSummary: {
    readonly requirementsTotal: number;
    readonly issuesFound: number;
    readonly blockingIssues: number;
  };
  readonly repairPlan: {
    readonly plan: RepairPlan | undefined;
    readonly approvedCount: number;
    readonly totalCount: number;
    readonly actions: Array<{
      readonly action: RepairAction;
      readonly approved: boolean;
      readonly executionResult?: { success: boolean; error?: string };
    }>;
  };
  readonly applyProgress: {
    readonly completed: number;
    readonly total: number;
    readonly actions: Array<{ label: string; status: 'pending' | 'running' | 'success' | 'failed'; error?: string }>;
  };
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

function getRepairPlan(state: ExtensionState): WorkflowModel['repairPlan'] {
  const plan = state.getRepairPlan();
  if (!plan) {
    return { plan: undefined, approvedCount: 0, totalCount: 0, actions: [] };
  }

  return {
    plan,
    approvedCount: state.getApprovedIds().length,
    totalCount: plan.actions.length,
    actions: plan.actions.map(action => ({
      action,
      approved: state.getApproval(action.id) === 'approved',
      executionResult: state.getExecution()?.results.find(r => r.action.id === action.id)?.result,
    })),
  };
}

function getApplyProgress(state: ExtensionState): WorkflowModel['applyProgress'] {
  const execution = state.getExecution();
  const plan = state.getRepairPlan();
  if (!execution || !plan) {
    return { completed: 0, total: 0, actions: [] };
  }

  const approvedIds = new Set(state.getApprovedIds());
  const approvedActions = plan.actions.filter(a => approvedIds.has(a.id));

  return {
    completed: execution.results.filter(r => r.result.success).length,
    total: approvedActions.length,
    actions: approvedActions.map(action => {
      const result = execution.results.find(r => r.action.id === action.id);
      if (!result) return { label: action.description, status: 'pending' as const };
      return {
        label: action.description,
        status: result.result.success ? 'success' as const : 'failed' as const,
        error: result.result.error,
      };
    }),
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

export function buildWorkflowModel(
  state: ExtensionState,
  options: { hasWorkspace: boolean; workspaceName: string; workspaceRoot: string }
): WorkflowModel {
  const aiConfig = {
    provider: vscode.workspace.getConfiguration('resolveit').get('ai.provider', 'none') as 'none' | 'local' | 'external',
    model: vscode.workspace.getConfiguration('resolveit').get('ai.model', ''),
    baseUrl: vscode.workspace.getConfiguration('resolveit').get('ai.baseUrl', ''),
    timeoutMs: vscode.workspace.getConfiguration('resolveit').get('ai.timeout', 30000),
  };

  const aiStatus = state.getAIStatus();
  const aiModeOptions = getAIModeOptions(aiConfig, aiStatus ? { available: aiStatus.available, provider: aiStatus.provider, model: aiStatus.model, baseUrl: aiStatus.baseUrl } : undefined);
  
  const projectName = state.getProjectName() ?? '(no project detected)';
  const projectRoot = options.workspaceRoot;
  
  let currentStep: WorkflowStep = 'ai-mode';
  const hasScanned = state.getHasScanned();
  const hasPlan = !!state.getRepairPlan();
  const hasExecution = !!state.getExecution();
  const hasVerification = !!state.getLastVerification();
  const hasError = !!state.getLastError();

  if (hasError && !hasVerification) {
    currentStep = 'failed';
  } else if (hasVerification) {
    const vr = getVerifyResult(state);
    currentStep = vr.success ? 'success' : 'failed';
  } else if (hasExecution) {
    currentStep = 'apply';
  } else if (hasPlan) {
    currentStep = 'repair-plan';
  } else if (hasScanned) {
    const blocking = state.blockingCount();
    currentStep = blocking > 0 ? 'status' : 'success';
  } else if (options.hasWorkspace) {
    currentStep = 'analyze';
  } else {
    currentStep = 'project';
  }

  const analyzeProgress = getAnalyzeProgress(state);
  const statusSummary = getStatusSummary(state);
  const repairPlan = getRepairPlan(state);
  const applyProgress = getApplyProgress(state);
  const verifyResult = getVerifyResult(state);

  const canGoBack = (currentStep as WorkflowStep) !== 'ai-mode' && (currentStep as WorkflowStep) !== 'project';
  const canGoForward = (currentStep as WorkflowStep) !== 'success' && (currentStep as WorkflowStep) !== 'failed';

  return {
    currentStep,
    canGoBack,
    canGoForward,
    workspaceName: options.workspaceName,
    workspaceRoot: options.workspaceRoot,
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
    errorMessage: state.getLastError()?.message,
  };
}