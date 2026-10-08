import type {
  AgentEvent,
  Diagnostic,
  EnvironmentInfo,
  ParsedRequirements,
  RepairAction,
  RepairPlan,
  RepairResult,
} from '../../src/index.js';

export interface LastRunSummary {
  readonly status: string;
  readonly timestamp: Date;
  readonly summary: string;
}

export interface LastVerification {
  readonly resolved: ReadonlyArray<string>;
  readonly remaining: ReadonlyArray<string>;
  readonly timestamp: Date;
}

export interface VerificationSummary {
  readonly resolved: ReadonlyArray<string>;
  readonly remaining: ReadonlyArray<string>;
  readonly message: string;
  readonly timestamp: Date;
}

export interface AIStatusState {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly available: boolean;
}

export type ApprovalState = 'awaiting' | 'approved' | 'denied';

export interface ActiveOperation {
  readonly kind: string;
  readonly activity: string;
}

export interface PlanExecutionSummary {
  readonly results: ReadonlyArray<{ action: RepairAction; result: RepairResult }>;
  readonly success: boolean;
  readonly timestamp: Date;
}

export interface ExtensionErrorState {
  readonly message: string;
  readonly timestamp: Date;
}

const MAX_EVENTS = 200;

export class ExtensionState {
  private diagnostics: Diagnostic[] = [];
  private environmentInfo?: EnvironmentInfo;
  private requirements: ParsedRequirements[] = [];
  private projectName?: string;
  private aiStatus?: AIStatusState;
  private lastRun?: LastRunSummary;
  private lastVerification?: LastVerification;
  private verificationSummary?: VerificationSummary;
  private events: AgentEvent[] = [];
  private revision = 0;
  private diagnosticsRevision = 0;
  private workspaceRoot?: string;
  private hasScanned = false;
  private activeOperation?: ActiveOperation;
  private repairPlan?: RepairPlan;
  /** True when the current plan was produced by the AI planner (not deterministic). */
  private repairPlanAiUsed = false;
  /** Human-readable notes about plan provenance (fallbacks, rejections, manual items). */
  private repairPlanNotices: ReadonlyArray<string> = [];
  private planDiagnosticsRevision = -1;
  private approvals = new Map<string, Exclude<ApprovalState, 'awaiting'>>();
  private execution?: PlanExecutionSummary;
  private lastError?: ExtensionErrorState;
  private aiSummary?: string;
  /** Set when the user finishes a passed verification; derives the Done stage. */
  private workflowCompleted = false;

  getRevision(): number {
    return this.revision;
  }

  getWorkspaceRoot(): string | undefined {
    return this.workspaceRoot;
  }

  bindWorkspace(root: string | undefined): boolean {
    if (this.workspaceRoot === root) {
      return false;
    }
    this.workspaceRoot = root;
    this.diagnostics = [];
    this.environmentInfo = undefined;
    this.requirements = [];
    this.projectName = undefined;
    this.lastRun = undefined;
    this.lastVerification = undefined;
    this.verificationSummary = undefined;
    this.workflowCompleted = false;
    this.events = [];
    this.hasScanned = false;
    this.activeOperation = undefined;
    this.repairPlan = undefined;
    this.repairPlanAiUsed = false;
    this.repairPlanNotices = [];
    this.planDiagnosticsRevision = -1;
    this.diagnosticsRevision = 0;
    this.approvals = new Map();
    this.execution = undefined;
    this.lastError = undefined;
    this.aiSummary = undefined;
    this.revision += 1;
    return true;
  }

  markScanned(): void {
    if (!this.hasScanned) {
      this.hasScanned = true;
      this.revision += 1;
    }
  }

  getHasScanned(): boolean {
    return this.hasScanned;
  }

  setActiveOperation(operation: ActiveOperation | undefined): void {
    this.activeOperation = operation;
    this.revision += 1;
  }

  getActiveOperation(): ActiveOperation | undefined {
    return this.activeOperation;
  }

  setRepairPlan(plan: RepairPlan, summary?: string, aiUsed = false): void {
    this.repairPlan = plan;
    this.repairPlanAiUsed = aiUsed;
    this.repairPlanNotices = [];
    this.approvals = new Map();
    this.execution = undefined;
    this.planDiagnosticsRevision = this.diagnosticsRevision;
    if (summary !== undefined) {
      this.aiSummary = summary;
    }
    this.revision += 1;
  }

  clearRepairPlan(): void {
    this.repairPlan = undefined;
    this.repairPlanAiUsed = false;
    this.repairPlanNotices = [];
    this.approvals = new Map();
    this.execution = undefined;
    this.revision += 1;
  }

  getRepairPlan(): RepairPlan | undefined {
    return this.repairPlan;
  }

  /** Whether the current plan came from the AI planner (false = deterministic). */
  getRepairPlanAiUsed(): boolean {
    return this.repairPlan !== undefined && this.repairPlanAiUsed;
  }

  setRepairPlanNotices(notices: ReadonlyArray<string>): void {
    this.repairPlanNotices = [...notices];
    this.revision += 1;
  }

  getRepairPlanNotices(): ReadonlyArray<string> {
    return this.repairPlanNotices;
  }

  isPlanStale(): boolean {
    return this.repairPlan !== undefined && this.planDiagnosticsRevision !== this.diagnosticsRevision;
  }

  setApproval(actionId: string, approved: boolean): void {
    this.approvals.set(actionId, approved ? 'approved' : 'denied');
    this.revision += 1;
  }

  getApproval(actionId: string): ApprovalState {
    return this.approvals.get(actionId) ?? 'awaiting';
  }

  getApprovedIds(): ReadonlyArray<string> {
    return [...this.approvals.entries()].filter(([, value]) => value === 'approved').map(([id]) => id);
  }

  getDecidedCount(): number {
    return this.approvals.size;
  }

  setExecution(execution: PlanExecutionSummary): void {
    this.execution = execution;
    this.revision += 1;
  }

  getExecution(): PlanExecutionSummary | undefined {
    return this.execution;
  }

  setLastError(message: string): void {
    this.lastError = { message, timestamp: new Date() };
    this.revision += 1;
  }

  clearLastError(): void {
    if (this.lastError !== undefined) {
      this.lastError = undefined;
      this.revision += 1;
    }
  }

  getLastError(): ExtensionErrorState | undefined {
    return this.lastError;
  }

  setAISummary(summary: string | undefined): void {
    this.aiSummary = summary;
    this.revision += 1;
  }

  getAISummary(): string | undefined {
    return this.aiSummary;
  }

  /**
   * Mark the workflow finished after a passed verification. This is what moves
   * the Verify stage to Done; it never skips verification itself.
   */
  markWorkflowCompleted(): void {
    this.workflowCompleted = true;
    this.revision += 1;
  }

  isWorkflowCompleted(): boolean {
    return this.workflowCompleted;
  }

  clearWorkflowCompleted(): void {
    if (this.workflowCompleted) {
      this.workflowCompleted = false;
      this.revision += 1;
    }
  }

  /**
   * Explicit workflow reset for Start Over. Clears everything the workflow
   * produced while keeping the current workspace binding (and the AI provider
   * status, which describes configuration, not workflow progress).
   */
  resetWorkflow(): void {
    this.diagnostics = [];
    this.environmentInfo = undefined;
    this.requirements = [];
    this.projectName = undefined;
    this.lastRun = undefined;
    this.lastVerification = undefined;
    this.verificationSummary = undefined;
    this.events = [];
    this.hasScanned = false;
    this.activeOperation = undefined;
    this.repairPlan = undefined;
    this.repairPlanAiUsed = false;
    this.repairPlanNotices = [];
    this.planDiagnosticsRevision = -1;
    this.diagnosticsRevision = 0;
    this.approvals = new Map();
    this.execution = undefined;
    this.lastError = undefined;
    this.aiSummary = undefined;
    this.workflowCompleted = false;
    this.revision += 1;
  }

  setDiagnostics(diagnostics: ReadonlyArray<Diagnostic>): void {
    this.diagnostics = [...diagnostics];
    this.diagnosticsRevision += 1;
    this.revision += 1;
  }

  getDiagnostics(): ReadonlyArray<Diagnostic> {
    return this.diagnostics;
  }

  getDiagnosticById(id: string): Diagnostic | undefined {
    return this.diagnostics.find((diagnostic) => diagnostic.id === id);
  }

  blockingCount(): number {
    return this.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'critical'
    ).length;
  }

  setEnvironment(environment: EnvironmentInfo): void {
    this.environmentInfo = environment;
    this.revision += 1;
  }

  getEnvironment(): EnvironmentInfo | undefined {
    return this.environmentInfo;
  }

  setRequirements(requirements: ReadonlyArray<ParsedRequirements>): void {
    this.requirements = [...requirements];
    this.revision += 1;
  }

  getRequirements(): ReadonlyArray<ParsedRequirements> {
    return this.requirements;
  }

  setProjectName(name: string): void {
    this.projectName = name;
    this.revision += 1;
  }

  getProjectName(): string | undefined {
    return this.projectName;
  }

  setAIStatus(status: AIStatusState): void {
    this.aiStatus = status;
    this.revision += 1;
  }

  getAIStatus(): AIStatusState | undefined {
    return this.aiStatus;
  }

  setLastRun(run: LastRunSummary): void {
    this.lastRun = run;
    this.revision += 1;
  }

  getLastRun(): LastRunSummary | undefined {
    return this.lastRun;
  }

  setLastVerification(verification: LastVerification): void {
    this.lastVerification = verification;
    this.revision += 1;
  }

  getLastVerification(): LastVerification | undefined {
    return this.lastVerification;
  }

  /**
   * Record a verification outcome without making it the current screen. Used when
   * returning to the repair plan so the failure reason survives the navigation.
   */
  recordVerificationSummary(summary: VerificationSummary): void {
    this.verificationSummary = summary;
    this.revision += 1;
  }

  getVerificationSummary(): VerificationSummary | undefined {
    return this.verificationSummary;
  }

  /**
   * Drop the current verification result so the workflow can advance past the
   * verify screen. The summary is retained for reporting.
   */
  clearLastVerification(): void {
    if (this.lastVerification !== undefined) {
      const current = this.lastVerification;
      // Do not clobber a summary that was deliberately recorded first, so an
      // explicit reason survives.
      if (!this.verificationSummary) {
        this.verificationSummary = {
          resolved: [...current.resolved],
          remaining: [...current.remaining],
          message:
            current.remaining.length === 0
              ? 'Previous attempt verified successfully.'
              : `Previous attempt did not resolve ${current.remaining.length} blocking issue(s).`,
          timestamp: current.timestamp,
        };
      }
      this.lastVerification = undefined;
      this.revision += 1;
    }
  }

  appendEvent(event: AgentEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }

  getEvents(): ReadonlyArray<AgentEvent> {
    return this.events;
  }

  clearRunHistory(): void {
    this.events = [];
    this.revision += 1;
  }
}
