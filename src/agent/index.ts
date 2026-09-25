export {
  AGENT_LIFECYCLE_STAGES,
  LIFECYCLE_TRANSITIONS,
  canTransition,
  createInitialAgentState,
  updateAgentState,
  transitionAgentState,
  SimpleAgentEngine,
} from './lifecycle.js';
export type { AgentEngine } from './lifecycle.js';

export {
  AGENT_RUN_STATES,
  AGENT_RUN_TRANSITIONS,
  canTransitionRunState,
  assertRunTransition,
  isTerminalRunState,
  toLifecycleStage,
} from './run-state.js';
export type { AgentRunState } from './run-state.js';

export { observeWorkspace } from './observation.js';
export type { AgentObservation } from './observation.js';

export { analyzeObservation, isBlockingDiagnostic, diagnosticKey } from './analysis.js';
export type { AgentAnalysis } from './analysis.js';

export {
  DeterministicRepairPlanner,
  createDeterministicRepairPlanner,
  actionFingerprint,
  MISSING_REQUIRED_FILE_CODE,
  MISSING_PYTHON_VENV_CODE,
  CONFIG_VALUE_MISMATCH_CODE,
} from './deterministic-planner.js';
export type {
  PlannedManualAction,
  PlanningInput,
  DeterministicPlan,
} from './deterministic-planner.js';

export { VerificationEngineImpl, createVerificationEngine, targetedCheck } from './verifier.js';
export type { VerificationReport, VerificationEvidence, TargetedCheck } from './verifier.js';

export { AgentRunner, createAgentRunner, DEFAULT_MAX_ITERATIONS } from './runner.js';
export type {
  AgentRunnerDeps,
  AgentRunOptions,
  AgentRunResult,
  AgentRunStatus,
  AgentRunContext,
  ApprovalRecord,
  ExecutedActionRecord,
  ObserverFn,
  AnalyzerFn,
  PlannerFn,
  PlanExecutor,
  VerificationEngineVerifyPlan,
} from './runner.js';

export type { AgentEvent, AgentEventType, AgentEventCallback } from './events.js';

export { createAIPlanner } from './ai-planner.js';
export type { AIPlannerCallbacks } from './ai-planner.js';
