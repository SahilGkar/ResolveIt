import {
  analyzeObservation,
  createAgentRunner,
  createAIPlanner,
  createAIProviderFromConfig,
  createDiagnosticEngine,
  createRepairExecutor,
  createRepairPlanner,
  diagnosticKey,
  isBlockingDiagnostic,
  observeWorkspace,
  sanitizeAIConfig,
  scanEnvironment,
  scanRequirements,
  scanWorkspace,
} from '../../src/index.js';
import type {
  AgentRunResult,
  AIConfig,
  Diagnostic,
  EnvironmentInfo,
  ParsedRequirements,
  PlannedManualAction,
  RepairAction,
  RepairExecutionOptions,
  RepairPlan,
  RepairResult,
  VerificationReport,
  Workspace,
} from '../../src/index.js';
import type { AgentEventCallback } from '../../src/index.js';

export interface AgentRunRequest {
  readonly workspaceRoot: string;
  readonly dryRun: boolean;
  readonly aiConfig: AIConfig;
  readonly maxIterations: number;
  readonly approvalCallback: (
    plan: RepairPlan,
    manualActions: ReadonlyArray<PlannedManualAction>
  ) => Promise<ReadonlyArray<string>>;
  readonly onEvent?: AgentEventCallback;
}

export interface CoreDependencies {
  readonly scanWorkspace: typeof scanWorkspace;
  readonly scanEnvironment: typeof scanEnvironment;
  readonly scanRequirements: typeof scanRequirements;
}

const defaultDeps: CoreDependencies = { scanWorkspace, scanEnvironment, scanRequirements };

export class CoreClient {
  private readonly deps: CoreDependencies;

  constructor(deps: Partial<CoreDependencies> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  scanProject(workspaceRoot: string): Promise<Workspace> {
    return this.deps.scanWorkspace(workspaceRoot, { maxDepth: 50, maxFiles: 100000 });
  }

  diagnoseProject(workspaceRoot: string, timeout = 60000): Promise<ReadonlyArray<Diagnostic>> {
    return this.runDiagnostics(workspaceRoot, timeout);
  }

  environmentInfo(timeout = 30000): Promise<EnvironmentInfo> {
    return this.deps.scanEnvironment({ timeout });
  }

  projectRequirements(workspaceRoot: string, timeout = 60000): Promise<ReadonlyArray<ParsedRequirements>> {
    return this.deps.scanRequirements(workspaceRoot, { timeout });
  }

  async planRepairs(workspaceRoot: string, timeout = 60000): Promise<{ plan: RepairPlan; diagnostics: ReadonlyArray<Diagnostic> }> {
    const { plan, diagnostics } = await this.planRepairsSmart(workspaceRoot, { provider: 'none' }, timeout);
    return { plan, diagnostics };
  }

  /**
   * Repair planning that honestly reports which engine produced the plan.
   *
   * - `provider: 'none'` (or an unavailable/erroring AI provider) uses the
   *   deterministic Core planner; `aiUsed` is false.
   * - A configured provider goes through `createAIPlanner`, which validates the
   *   AI response against the Core trust boundary (`validateAIPlan`) and falls
   *   back to deterministic planning when the AI is unavailable or invalid;
   *   `aiUsed` is true only when validated AI actions survived.
   */
  async planRepairsSmart(
    workspaceRoot: string,
    aiConfig: AIConfig,
    timeout = 60000
  ): Promise<{
    plan: RepairPlan;
    diagnostics: ReadonlyArray<Diagnostic>;
    aiUsed: boolean;
    aiRejections: ReadonlyArray<string>;
    fallbackReason?: string;
    manualActions: ReadonlyArray<PlannedManualAction>;
  }> {
    const diagnostics = await this.runDiagnostics(workspaceRoot, timeout);
    if (aiConfig.provider === 'none') {
      const plan = await this.deterministicPlan(workspaceRoot, diagnostics);
      return { plan, diagnostics, aiUsed: false, aiRejections: [], manualActions: [] };
    }

    const provider = createAIProviderFromConfig(aiConfig);
    const aiRejections: string[] = [];
    let fallbackReason: string | undefined;
    const planner = createAIPlanner(
      provider,
      {
        onFallback: (reason, details) => {
          fallbackReason = details ?? reason;
        },
        onAIResult: (info) => {
          aiRejections.push(...info.rejections);
        },
      }
    );
    const observation = await observeWorkspace(workspaceRoot, timeout);
    const analysis = await analyzeObservation(observation);
    const result = await planner({
      analysis,
      workspaceRoot,
      attemptedFingerprints: new Set<string>(),
      previousAttempts: [],
    });
    return {
      plan: result.plan,
      diagnostics,
      aiUsed: result.aiUsed === true,
      aiRejections,
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
      manualActions: result.manualActions,
    };
  }

  private async deterministicPlan(workspaceRoot: string, diagnostics: ReadonlyArray<Diagnostic>): Promise<RepairPlan> {
    const planner = createRepairPlanner();
    const workspace = await this.deps.scanWorkspace(workspaceRoot, { maxDepth: 50, maxFiles: 100000 });
    const plan = await planner.createPlan(diagnostics, {
      workspace,
      diagnosis: { id: `diag-${Date.now()}`, summary: `${diagnostics.length} diagnostics`, rootCauses: [], confidence: 1, timestamp: new Date() },
      constraints: {
        maxRiskLevel: 'system-modification',
        allowedActions: [
          'install-dependency',
          'update-manifest',
          'create-environment',
          'modify-configuration',
          'run-script',
          'install-tool',
          'upgrade-runtime',
          'apply-patch',
          'set-variable',
          'custom',
        ],
        requireApproval: true,
      },
    });
    return plan;
  }

  executeApproved(
    workspaceRoot: string,
    plan: RepairPlan,
    approvedIds: ReadonlyArray<string>
  ): Promise<{ results: ReadonlyArray<{ action: RepairAction; result: RepairResult }>; success: boolean }> {
    const executor = createRepairExecutor(workspaceRoot);
    const approved = new Set(approvedIds);
    const options: RepairExecutionOptions = {
      dryRun: false,
      workspaceRoot,
      approvalCallback: (action) => Promise.resolve(approved.has(action.id) ? 'allowed' : 'denied'),
    };
    return executor.executePlan(plan, options);
  }

  runAgent(request: AgentRunRequest): Promise<{ context: unknown; result: AgentRunResult }> {
    const provider = createAIProviderFromConfig(request.aiConfig);
    const planner = createAIPlanner(provider);
    const runner = createAgentRunner({ plan: planner, onEvent: request.onEvent });
    return runner.run({
      workspaceRoot: request.workspaceRoot,
      dryRun: request.dryRun,
      maxIterations: request.maxIterations,
      approvalCallback: (plan, manualActions) => request.approvalCallback(plan, manualActions),
    });
  }

  async verifyAgainstPrevious(
    workspaceRoot: string,
    previous: ReadonlyArray<Diagnostic>,
    timeout = 60000
  ): Promise<{ resolved: string[]; remaining: string[]; current: ReadonlyArray<Diagnostic> }> {
    const current = await this.runDiagnostics(workspaceRoot, timeout);
    const before = new Set(previous.filter(isBlockingDiagnostic).map(diagnosticKey));
    const after = new Set(current.filter(isBlockingDiagnostic).map(diagnosticKey));
    return {
      resolved: [...before].filter((key) => !after.has(key)),
      remaining: [...after],
      current,
    };
  }

  async aiStatus(aiConfig: AIConfig): Promise<{ provider: string; name: string; model: string; baseUrl: string; apiKeyConfigured: boolean; available: boolean }> {
    const provider = createAIProviderFromConfig(aiConfig);
    const sanitized = sanitizeAIConfig(aiConfig);
    let available = false;
    try {
      available = await provider.isAvailable();
    } catch {
      available = false;
    }
    return {
      provider: sanitized.provider,
      name: provider.name,
      model: sanitized.model ?? '(not configured)',
      baseUrl: sanitized.baseUrl ?? '(not configured)',
      apiKeyConfigured: sanitized.apiKeyConfigured,
      available,
    };
  }

  private async runDiagnostics(workspaceRoot: string, timeout: number): Promise<ReadonlyArray<Diagnostic>> {
    const [workspace, environment, requirements] = await Promise.all([
      this.deps.scanWorkspace(workspaceRoot, { maxDepth: 50, maxFiles: 100000 }),
      this.deps.scanEnvironment({ timeout }),
      this.deps.scanRequirements(workspaceRoot, { timeout }),
    ]);
    const engine = createDiagnosticEngine();
    return engine.runDiagnosticsWithContext(workspace, environment, requirements);
  }
}

export type { VerificationReport };
