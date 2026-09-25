export {
  Project,
  Workspace,
  Environment,
  Diagnostic,
  RepairAction,
  RepairPlan,
  VerificationResult,
  AgentState,
  AgentEvidence,
  DiagnosisResult,
  PlanContext,
  Language,
  Ecosystem,
  Tool,
  Requirement,
  Dependency,
  RiskLevel,
  ProjectType,
  ManifestFormat,
  DependencySource,
  DependencyScope,
  EnvironmentType,
  RequirementType,
  DiagnosticSeverity,
  DiagnosticCategory,
  DiagnosticEvidence,
  RemediationCandidate,
  DiagnosticSource,
  RepairActionType,
  ToolCapability,
  AgentLifecycleStage,
  SourceFile,
  DirectoryInfo,
  ProjectMarker,
  ConfigFile,
  RepoIndicator,
  ScanError,
  SourceClassification,
  ProjectMarkerType,
  ConfigFileType,
  RepoIndicatorType,
  ToolInstallation,
  EnvironmentInfo,
  OSInfo,
  ContainerInfo,
  ProjectRequirement,
  ProjectRequirementType,
  ParsedRequirements,
  RequirementParseError,
  VersionConstraint,
  VersionOperator,
  DependencyManifest,
  ParsedDependency,
  RuntimeRequirement,
  ToolchainRequirement,
  ContainerRequirement,
  RepairToolRegistry,
  RepairExecutionResult,
  RollbackResult,
  RepairResult,
  AIProposedAction,
  AIPlanningResult,
  AIPlanningContext,
  AIWorkspaceSummary,
  AIEnvironmentSummary,
  AIRequirementSummary,
  AIDiagnosticSummary,
  AIToolDescriptor,
  AIPlanningConstraints,
  AIPreviousAttempt,
  AIVerificationSummary,
} from './core/models.js';

export {
  WorkspaceManager,
  LanguageAnalyzer,
  EnvironmentAdapter,
  DiagnosticEngine,
  VerificationEngine,
  AIProvider,
  Agent,
  PermissionManager,
  AuditLogger,
  ToolRegistry,
  ProjectAnalysis,
  RuntimeInfo,
  CommandResult,
  RepairContext,
  VerificationContext,
  VerificationRule,
  ApprovalResult,
  PermissionPolicy,
  AuditEvent,
  AuditActor,
  AuditTarget,
  AuditQuery,
  AuditEventType,
  PlanConstraints,
  RootCause,
  EnvironmentSnapshot,
  RequirementParser,
  RequirementManager,
  VersionMatcher,
  DiagnosticRule,
  DiagnosticContext,
} from './core/interfaces.js';

export { NoAIProvider, AIProviderConfig, LocalAIConfig, ExternalAIConfig, createAIProvider, AIProviderType } from './ai/providers.js';

export type { AIConfig, SanitizedAIConfig } from './ai/config.js';

export { DEFAULT_PERMISSION_POLICY, getActionRiskLevel, checkPermission, PermissionManagerImpl } from './safety/permission.js';

export { AGENT_LIFECYCLE_STAGES, LIFECYCLE_TRANSITIONS, canTransition, createInitialAgentState, updateAgentState, transitionAgentState, AgentEngine, SimpleAgentEngine } from './agent/lifecycle.js';

export { scanWorkspace, type ScannerOptions } from './scanners/index.js';
export { WorkspaceManagerImpl, createWorkspaceManager } from './core/workspace-manager.js';

export {
  scanEnvironment,
  createEnvironmentScanner,
  createMockEnvironmentScanner,
  formatEnvironmentSummary,
  environmentInfoToJSON,
  type EnvironmentScannerOptions,
} from './environment/index.js';

export {
  detectOS,
  formatOSInfo,
} from './environment/adapters/os.js';

export {
  detectAllRuntimes,
  RUNTIME_DEFINITIONS,
} from './environment/adapters/runtime.js';

export {
  detectAllDevTools,
  type ToolDefinition,
  DEV_TOOL_DEFINITIONS,
} from './environment/adapters/tools.js';

export {
  detectAllPackageManagers,
  type PackageManagerDefinition,
  PACKAGE_MANAGER_DEFINITIONS,
} from './environment/adapters/package-managers.js';

export {
  detectContainers,
} from './environment/adapters/containers.js';

export {
  CommandRunner,
  createCommandRunner,
  createMockCommandRunner,
  type CommandRunnerOptions,
} from './environment/command-runner.js';

export {
  scanRequirements,
  createRequirementManager,
  type RequirementScannerOptions,
} from './requirements/index.js';

export {
  diagnose,
  formatDiagnosticsSummary,
  diagnosticsToJSON,
  createDiagnosticEngine,
  versionMatcher,
  runtimeDiagnosticRule,
  toolchainDiagnosticRule,
  containerDiagnosticRule,
  dependencyDiagnosticRule,
  buildDiagnosticRule,
  projectDiagnosticRule,
  type DiagnoseOptions,
} from './diagnostics/index.js';

export {
  createRepairExecutor,
  createRepairPlanner,
  createAuditLogger,
  createSnapshotManager,
  type RepairExecutionOptions,
} from './repair/index.js';

export {
  AGENT_RUN_STATES,
  AGENT_RUN_TRANSITIONS,
  canTransitionRunState,
  assertRunTransition,
  isTerminalRunState,
  toLifecycleStage,
  observeWorkspace,
  analyzeObservation,
  isBlockingDiagnostic,
  diagnosticKey,
  DeterministicRepairPlanner,
  createDeterministicRepairPlanner,
  actionFingerprint,
  MISSING_REQUIRED_FILE_CODE,
  MISSING_PYTHON_VENV_CODE,
  CONFIG_VALUE_MISMATCH_CODE,
  VerificationEngineImpl,
  createVerificationEngine,
  targetedCheck,
  AgentRunner,
  createAgentRunner,
  DEFAULT_MAX_ITERATIONS,
  createAIPlanner,
} from './agent/index.js';

export type {
  AgentRunState,
  AgentObservation,
  AgentAnalysis,
  PlannedManualAction,
  PlanningInput,
  DeterministicPlan,
  VerificationReport,
  VerificationEvidence,
  TargetedCheck,
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
  AgentEvent,
  AgentEventType,
  AgentEventCallback,
  AIPlannerCallbacks,
} from './agent/index.js';

export {
  resolveAIConfig,
  sanitizeAIConfig,
  normalizeAIProviderType,
  DEFAULT_AI_CONFIG,
  DEFAULT_AI_TIMEOUT_MS,
  DEFAULT_LOCAL_BASE_URL,
  AIProviderError,
  isAIProviderError,
  buildAIPlanningContext,
  describeAvailableTools,
  toolNameForActionType,
  buildPlanningPrompt,
  parseAIPlanningResponse,
  validateAIAction,
  validateAIPlan,
  LocalAIProvider,
  ExternalAIProvider,
  createAIProviderFromConfig,
} from './ai/index.js';