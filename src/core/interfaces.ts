import type {
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
  AgentLifecycleStage,
  PlanConstraints,
  RootCause,
  EnvironmentSnapshot,
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
} from './models.js';

export type {
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
  AgentLifecycleStage,
  PlanConstraints,
  RootCause,
  EnvironmentSnapshot,
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
};

export interface WorkspaceManager {
  discoverWorkspace(rootPath: string): Promise<Workspace>;
  getProject(projectId: string): Project | undefined;
  getProjects(): ReadonlyArray<Project>;
  getEnvironments(): ReadonlyArray<Environment>;
  watchWorkspace(callback: WorkspaceChangeCallback): WorkspaceWatcher;
}

export interface WorkspaceChangeCallback {
  (event: WorkspaceChangeEvent): void;
}

export interface WorkspaceWatcher {
  dispose(): void;
}

export type WorkspaceChangeEvent =
  | { type: 'project-added'; project: Project }
  | { type: 'project-removed'; projectId: string }
  | { type: 'project-changed'; project: Project }
  | { type: 'environment-added'; environment: Environment }
  | { type: 'environment-removed'; environmentId: string }
  | { type: 'environment-changed'; environment: Environment };

export interface LanguageAnalyzer {
  readonly languageId: string;
  readonly supportedEcosystems: ReadonlyArray<string>;
  
  analyzeProject(project: Project): Promise<ProjectAnalysis>;
  diagnoseProject(project: Project): Promise<ReadonlyArray<Diagnostic>>;
  suggestRepairs(diagnostics: ReadonlyArray<Diagnostic>): Promise<ReadonlyArray<RepairAction>>;
  verifyRepair(action: RepairAction, project: Project): Promise<VerificationResult>;
}

export interface ProjectAnalysis {
  readonly projectId: string;
  readonly language: Language;
  readonly ecosystems: ReadonlyArray<Ecosystem>;
  readonly requirements: ReadonlyArray<Requirement>;
  readonly dependencies: ReadonlyArray<Dependency>;
  readonly issues: ReadonlyArray<Diagnostic>;
}

export interface EnvironmentAdapter {
  readonly environmentType: string;
  
  detect(): Promise<Environment | null>;
  getRuntime(): Promise<RuntimeInfo>;
  getTools(): Promise<ReadonlyArray<Tool>>;
  getVariables(): Promise<Readonly<Record<string, string>>>;
  executeCommand(command: string, args: ReadonlyArray<string>): Promise<CommandResult>;
}

export interface RuntimeInfo {
  readonly name: string;
  readonly version: string;
  readonly path: string;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DiagnosticEngine {
  runDiagnostics(workspace: Workspace): Promise<ReadonlyArray<Diagnostic>>;
  runDiagnosticsForProject(project: Project): Promise<ReadonlyArray<Diagnostic>>;
  registerDiagnosticSource(source: DiagnosticSource): void;
}

export interface DiagnosticSource {
  readonly id: string;
  readonly name: string;
  diagnose(workspace: Workspace): Promise<ReadonlyArray<Diagnostic>>;
}

export interface RepairTool {
  readonly actionType: string;
  readonly supportedRiskLevels: ReadonlyArray<RiskLevel>;
  
  canHandle(action: RepairAction): boolean;
  execute(action: RepairAction, context: RepairContext): Promise<RepairExecutionResult>;
  rollback(action: RepairAction, context: RepairContext): Promise<RollbackResult>;
}

export interface RepairContext {
  readonly workspace: Workspace;
  readonly project?: Project;
  readonly environment?: Environment;
  readonly dryRun: boolean;
}

export interface RepairExecutionResult {
  readonly success: boolean;
  readonly output: string;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RollbackResult {
  readonly success: boolean;
  readonly output: string;
}

export interface VerificationEngine {
  verify(action: RepairAction, context: VerificationContext): Promise<VerificationResult>;
  registerVerificationRule(rule: VerificationRule): void;
}

export interface VerificationContext {
  readonly workspace: Workspace;
  readonly project?: Project;
  readonly environment?: Environment;
  readonly originalDiagnostics: ReadonlyArray<Diagnostic>;
}

export interface VerificationRule {
  readonly id: string;
  readonly name: string;
  readonly applicableActionTypes: ReadonlyArray<string>;
  verify(context: VerificationContext): Promise<VerificationResult>;
}

export interface AIProvider {
  readonly type: 'none' | 'local' | 'external';
  readonly name: string;
  readonly version: string;
  
  isAvailable(): Promise<boolean>;
  diagnose(evidence: AgentEvidence): Promise<DiagnosisResult>;
  planRepair(diagnosis: DiagnosisResult, context: PlanContext): Promise<RepairPlan>;
}

export interface Agent {
  readonly id: string;
  readonly name: string;
  
  initialize(workspace: Workspace): Promise<void>;
  observe(): Promise<AgentEvidence>;
  analyze(evidence: AgentEvidence): Promise<DiagnosisResult>;
  plan(diagnosis: DiagnosisResult, context: PlanContext): Promise<RepairPlan>;
  requestApproval(plan: RepairPlan): Promise<ApprovalResult>;
  act(plan: RepairPlan, approval: ApprovalResult): Promise<ReadonlyArray<VerificationResult>>;
  verify(results: ReadonlyArray<VerificationResult>): Promise<AgentState>;
  getState(): AgentState;
  shutdown(): Promise<void>;
}

export interface ApprovalResult {
  readonly approved: boolean;
  readonly approvedActions: ReadonlyArray<string>;
  readonly rejectedActions: ReadonlyArray<string>;
  readonly reason?: string;
}

export interface PermissionManager {
  readonly policy: PermissionPolicy;
  
  checkPermission(action: RepairAction): PermissionDecision;
  requestApproval(action: RepairAction, reason: string): Promise<ApprovalResult>;
  recordDecision(actionId: string, decision: PermissionDecision): void;
}

export interface PermissionPolicy {
  readonly readOnlyActions: ReadonlyArray<string>;
  readonly projectModificationActions: ReadonlyArray<string>;
  readonly systemModificationActions: ReadonlyArray<string>;
  readonly autoApproveReadOnly: boolean;
  readonly requireConfirmationForProjectModification: boolean;
  readonly requireConfirmationForSystemModification: boolean;
}

export type PermissionDecision = 'allowed' | 'requires-approval' | 'denied';

export interface AuditLogger {
  log(event: AuditEvent): Promise<void>;
  query(query: AuditQuery): Promise<ReadonlyArray<AuditEvent>>;
}

export interface AuditEvent {
  readonly id: string;
  readonly timestamp: Date;
  readonly type: AuditEventType;
  readonly actor: AuditActor;
  readonly action: string;
  readonly target: AuditTarget;
  readonly result: 'success' | 'failure' | 'pending';
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type AuditEventType =
  | 'workspace-discovered'
  | 'diagnostic-run'
  | 'repair-planned'
  | 'approval-requested'
  | 'approval-granted'
  | 'approval-denied'
  | 'repair-executed'
  | 'repair-rolled-back'
  | 'verification-run'
  | 'agent-state-change'
  | 'error';

export interface AuditActor {
  readonly type: 'user' | 'agent' | 'system';
  readonly id: string;
}

export interface AuditTarget {
  readonly type: 'workspace' | 'project' | 'environment' | 'tool' | 'configuration';
  readonly id: string;
}

export interface AuditQuery {
  readonly startTime?: Date;
  readonly endTime?: Date;
  readonly types?: ReadonlyArray<AuditEventType>;
  readonly actorId?: string;
  readonly targetId?: string;
  readonly limit?: number;
}

export interface ToolRegistry {
  register(tool: Tool): void;
  unregister(toolId: string): void;
  getTool(toolId: string): Tool | undefined;
  getToolsByCapability(capability: string): ReadonlyArray<Tool>;
  getAllTools(): ReadonlyArray<Tool>;
  findToolForAction(actionType: string): Tool | undefined;
}