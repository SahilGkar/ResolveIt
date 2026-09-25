import type {
  Diagnostic,
  PermissionDecision,
  RepairAction,
  RepairPlan,
  RepairResult,
} from '../core/models.js';
import {
  createRepairExecutor,
  sanitizeParameters,
} from '../repair/index.js';
import { PermissionManagerImpl } from '../safety/permission.js';
import { assertRunTransition, isTerminalRunState } from './run-state.js';
import type { AgentRunState } from './run-state.js';
import { observeWorkspace } from './observation.js';
import type { AgentObservation } from './observation.js';
import { analyzeObservation } from './analysis.js';
import type { AgentAnalysis } from './analysis.js';
import { createDeterministicRepairPlanner, actionFingerprint } from './deterministic-planner.js';
import type { DeterministicPlan, PlannedManualAction } from './deterministic-planner.js';
import { createVerificationEngine } from './verifier.js';
import type { VerificationReport } from './verifier.js';
import type { AgentEvent, AgentEventCallback, AgentEventType } from './events.js';

export const DEFAULT_MAX_ITERATIONS = 3;

export type ObserverFn = (workspaceRoot: string) => Promise<AgentObservation>;
export type AnalyzerFn = (observation: AgentObservation) => Promise<AgentAnalysis>;
export type PlannerFn = (
  input: { analysis: AgentAnalysis; workspaceRoot: string; attemptedFingerprints: ReadonlySet<string> }
) => Promise<DeterministicPlan>;

export interface PlanExecutor {
  executePlan(
    plan: RepairPlan,
    options: {
      dryRun: boolean;
      workspaceRoot: string;
      approvalCallback?: (action: RepairAction) => Promise<PermissionDecision>;
    }
  ): Promise<{
    readonly results: ReadonlyArray<{ action: RepairAction; result: RepairResult }>;
    readonly success: boolean;
  }>;
}

export interface AgentRunnerDeps {
  readonly observe?: ObserverFn;
  readonly analyze?: AnalyzerFn;
  readonly plan?: PlannerFn;
  readonly executorFactory?: (workspaceRoot: string) => PlanExecutor;
  readonly verifier?: { verifyPlan: VerificationEngineVerifyPlan };
  readonly permissionManager?: PermissionManagerImpl;
  readonly onEvent?: AgentEventCallback;
}

export type VerificationEngineVerifyPlan = (
  executed: ReadonlyArray<{ action: RepairAction; result: RepairResult }>,
  before: AgentAnalysis,
  after: AgentAnalysis,
  workspaceRoot: string
) => Promise<VerificationReport>;

export interface AgentRunOptions {
  readonly workspaceRoot: string;
  readonly maxIterations?: number;
  readonly dryRun?: boolean;
  readonly timeout?: number;
  readonly approvalCallback?: (
    plan: RepairPlan,
    manualActions: ReadonlyArray<PlannedManualAction>
  ) => Promise<ReadonlyArray<string>>;
}

export type AgentRunStatus = 'resolved' | 'failed' | 'manual-action-required' | 'awaiting-approval';

export interface ApprovalRecord {
  readonly planId: string;
  readonly approvedActionIds: ReadonlyArray<string>;
  readonly deniedActionIds: ReadonlyArray<string>;
  readonly timestamp: Date;
}

export interface ExecutedActionRecord {
  readonly action: RepairAction;
  readonly result: RepairResult;
}

export interface AgentRunContext {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly state: AgentRunState;
  readonly iterations: number;
  readonly observation?: AgentObservation;
  readonly analysis?: AgentAnalysis;
  readonly plans: ReadonlyArray<DeterministicPlan>;
  readonly approvals: ReadonlyArray<ApprovalRecord>;
  readonly executedActions: ReadonlyArray<ExecutedActionRecord>;
  readonly verificationReports: ReadonlyArray<VerificationReport>;
  readonly failedFingerprints: ReadonlyArray<string>;
  readonly events: ReadonlyArray<AgentEvent>;
  readonly startedAt: Date;
  readonly updatedAt: Date;
}

export interface AgentRunResult {
  readonly runId: string;
  readonly status: AgentRunStatus;
  readonly reason?: string;
  readonly iterations: number;
  readonly remainingDiagnostics: ReadonlyArray<string>;
  readonly manualActions: ReadonlyArray<PlannedManualAction>;
  readonly verificationReports: ReadonlyArray<VerificationReport>;
}

function sanitizedPlan(plan: RepairPlan): RepairPlan {
  return {
    ...plan,
    actions: plan.actions.map((action) => ({
      ...action,
      parameters: sanitizeParameters(action.parameters),
    })),
  };
}

function sanitizedObservation(observation: AgentObservation): AgentObservation {
  return {
    ...observation,
    environment: {
      ...observation.environment,
      environmentVariables: sanitizeParameters(
        observation.environment.environmentVariables
      ) as Record<string, string>,
    },
  };
}

function sanitizedAnalysis(analysis: AgentAnalysis): AgentAnalysis {
  const sanitizeDiagnostics = (diagnostics: ReadonlyArray<Diagnostic>) =>
    diagnostics.map((diagnostic) => ({
      ...diagnostic,
      remediationCandidates: diagnostic.remediationCandidates?.map((candidate) => ({
        ...candidate,
        payload: sanitizeParameters(candidate.payload),
      })),
    }));
  return {
    ...analysis,
    observation: sanitizedObservation(analysis.observation),
    diagnostics: sanitizeDiagnostics(analysis.diagnostics),
    blockingDiagnostics: sanitizeDiagnostics(analysis.blockingDiagnostics),
  };
}

export class AgentRunner {
  private readonly observeFn: ObserverFn;
  private readonly analyzeFn: AnalyzerFn;
  private readonly planFn: PlannerFn;
  private readonly executorFactory: (workspaceRoot: string) => PlanExecutor;
  private readonly verifyPlanFn: VerificationEngineVerifyPlan;
  private readonly permissionManager: PermissionManagerImpl;
  private readonly onEvent?: AgentEventCallback;

  constructor(deps: AgentRunnerDeps = {}) {
    const defaultPlanner = createDeterministicRepairPlanner();
    const defaultVerifier = createVerificationEngine();
    this.observeFn = deps.observe ?? ((root: string) => observeWorkspace(root));
    this.analyzeFn = deps.analyze ?? ((obs: AgentObservation) => analyzeObservation(obs));
    this.planFn = deps.plan ?? ((input) => defaultPlanner.createPlan(input));
    this.executorFactory =
      deps.executorFactory ?? ((root: string) => createRepairExecutor(root));
    this.verifyPlanFn =
      deps.verifier?.verifyPlan ??
      ((executed, before, after, root) => defaultVerifier.verifyPlan(executed, before, after, root));
    this.permissionManager = deps.permissionManager ?? new PermissionManagerImpl();
    this.onEvent = deps.onEvent;
  }

  async run(options: AgentRunOptions): Promise<{ context: AgentRunContext; result: AgentRunResult }> {
    const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const startedAt = new Date();

    let state: AgentRunState = 'idle';
    let iterations = 0;
    let observation: AgentObservation | undefined;
    let analysis: AgentAnalysis | undefined;
    const plans: DeterministicPlan[] = [];
    const approvals: ApprovalRecord[] = [];
    const executedActions: ExecutedActionRecord[] = [];
    const verificationReports: VerificationReport[] = [];
    const failedFingerprints = new Set<string>();
    const events: AgentEvent[] = [];
    let seq = 0;

    const emit = (type: AgentEventType, data?: Readonly<Record<string, unknown>>): void => {
      seq += 1;
      const event: AgentEvent = {
        seq,
        type,
        runId,
        timestamp: new Date(),
        state,
        ...(data === undefined ? {} : { data }),
      };
      events.push(event);
      this.onEvent?.(event);
    };

    const transition = (to: AgentRunState): void => {
      assertRunTransition(state, to);
      state = to;
    };

    const snapshot = (): AgentRunContext => ({
      id: runId,
      workspaceRoot: options.workspaceRoot,
      state,
      iterations,
      ...(observation === undefined ? {} : { observation: sanitizedObservation(observation) }),
      ...(analysis === undefined ? {} : { analysis: sanitizedAnalysis(analysis) }),
      plans: plans.map((entry) => ({ ...entry, plan: sanitizedPlan(entry.plan) })),
      approvals: [...approvals],
      executedActions: [...executedActions],
      verificationReports: [...verificationReports],
      failedFingerprints: [...failedFingerprints],
      events: [...events],
      startedAt,
      updatedAt: new Date(),
    });

    const finish = (
      status: AgentRunStatus,
      reason?: string,
      remainingDiagnostics: ReadonlyArray<string> = [],
      manualActions: ReadonlyArray<PlannedManualAction> = []
    ): { context: AgentRunContext; result: AgentRunResult } => ({
      context: snapshot(),
      result: {
        runId,
        status,
        ...(reason === undefined ? {} : { reason }),
        iterations,
        remainingDiagnostics,
        manualActions,
        verificationReports: [...verificationReports],
      },
    });

    try {
      transition('observing');
      emit('observation-started', { workspaceRoot: options.workspaceRoot });
      observation = await this.observeFn(options.workspaceRoot);
      emit('observation-completed', {
        projects: observation.workspace.projects.length,
        requirements: observation.requirements.length,
      });

      transition('analyzing');
      analysis = await this.analyzeFn(observation);
      emit('analysis-completed', {
        diagnostics: analysis.diagnostics.length,
        blocking: analysis.blockingDiagnostics.length,
      });

      if (analysis.blockingDiagnostics.length === 0) {
        transition('resolved');
        emit('resolved', { reason: 'No blocking diagnostics' });
        return finish('resolved', 'No blocking diagnostics');
      }

      while (iterations < maxIterations) {
        iterations += 1;
        transition('planning');

        const deterministic = await this.planFn({
          analysis,
          workspaceRoot: options.workspaceRoot,
          attemptedFingerprints: failedFingerprints,
        });
        plans.push(deterministic);
        emit('plan-created', {
          planId: deterministic.plan.id,
          actions: deterministic.plan.actions.map((action) => ({
            id: action.id,
            type: action.type,
            permissionLevel: action.permissionLevel,
          })),
          manualActions: deterministic.manualActions.length,
        });

        transition('awaiting-approval');
        emit('approval-requested', {
          planId: deterministic.plan.id,
          requiresApproval: deterministic.plan.requiresApproval,
          manualActions: deterministic.manualActions.map((manual) => manual.description),
        });

        if (options.dryRun) {
          return finish('awaiting-approval', 'Dry run stopped before modifications', [], deterministic.manualActions);
        }

        const executable = deterministic.plan.actions;
        const approvedIds = new Set(
          options.approvalCallback
            ? await options.approvalCallback(deterministic.plan, deterministic.manualActions)
            : []
        );
        for (const action of executable) {
          if (action.permissionLevel === 'read-only' &&
              this.permissionManager.checkPermission(action) === 'allowed') {
            approvedIds.add(action.id);
          }
        }
        const approved = executable.filter((action) => approvedIds.has(action.id));
        const denied = executable.filter((action) => !approvedIds.has(action.id));
        approvals.push({
          planId: deterministic.plan.id,
          approvedActionIds: approved.map((action) => action.id),
          deniedActionIds: denied.map((action) => action.id),
          timestamp: new Date(),
        });
        if (approved.length > 0) {
          emit('approval-granted', { planId: deterministic.plan.id, approved: approved.map((a) => a.id) });
        }
        if (denied.length > 0) {
          emit('approval-denied', { planId: deterministic.plan.id, denied: denied.map((a) => a.id) });
        }

        if (executable.length === 0) {
          transition('failed');
          const reason = deterministic.manualActions.length > 0 ? 'manual-action-required' : 'no-safe-repair';
          emit('failed', { reason, manualActions: deterministic.manualActions.length });
          return finish(
            deterministic.manualActions.length > 0 ? 'manual-action-required' : 'failed',
            reason === 'manual-action-required'
              ? `Manual action required: ${deterministic.manualActions.map((m) => m.description).join('; ')}`
              : 'Planner produced no safe repair for the remaining diagnostics',
            analysis.blockingDiagnostics.map((d) => d.id),
            deterministic.manualActions
          );
        }

        if (approved.length === 0) {
          transition('failed');
          emit('failed', { reason: 'approval-denied' });
          return finish('failed', 'All planned actions were denied approval', analysis.blockingDiagnostics.map((d) => d.id), deterministic.manualActions);
        }

        transition('acting');
        const approvedPlan: RepairPlan = { ...deterministic.plan, actions: approved };
        const executor = this.executorFactory(options.workspaceRoot);
        for (const action of approved) {
          emit('action-started', { actionId: action.id, type: action.type });
        }
        const execution = await executor.executePlan(approvedPlan, {
          dryRun: false,
          workspaceRoot: options.workspaceRoot,
          approvalCallback: (action) =>
            Promise.resolve<PermissionDecision>(approvedIds.has(action.id) ? 'allowed' : 'denied'),
        });
        for (const { action, result } of execution.results) {
          executedActions.push({
            action: { ...action, parameters: sanitizeParameters(action.parameters) },
            result,
          });
          if (result.success) {
            emit('action-completed', { actionId: action.id });
          } else {
            emit('action-failed', { actionId: action.id, error: result.error ?? 'unknown' });
            failedFingerprints.add(actionFingerprint(action));
          }
        }

        transition('verifying');
        emit('verification-started', { planId: deterministic.plan.id });
        const afterObservation = await this.observeFn(options.workspaceRoot);
        const afterAnalysis = await this.analyzeFn(afterObservation);
        const report = await this.verifyPlanFn(execution.results, analysis, afterAnalysis, options.workspaceRoot);
        verificationReports.push(report);
        emit('verification-completed', { success: report.success, summary: report.summary });

        if (report.success) {
          transition('resolved');
          emit('resolved', { iterations });
          return finish('resolved', `Resolved after ${iterations} iteration(s)`);
        }

        observation = afterObservation;
        analysis = afterAnalysis;

        if (iterations >= maxIterations) {
          transition('failed');
          emit('failed', { reason: 'max-iterations', remaining: report.remainingDiagnostics.length });
          return finish(
            'failed',
            `Verification failed after ${maxIterations} iteration(s): ${report.summary}`,
            report.remainingDiagnostics,
            deterministic.manualActions
          );
        }

        transition('replanning');
        emit('replanning', { iteration: iterations, remaining: report.remainingDiagnostics.length });
        transition('analyzing');
        if (analysis.blockingDiagnostics.length === 0) {
          transition('resolved');
          emit('resolved', { reason: 'No blocking diagnostics after re-observation' });
          return finish('resolved', 'No blocking diagnostics after re-observation');
        }
      }

      transition('failed');
      emit('failed', { reason: 'max-iterations' });
      return finish('failed', `Repair did not verify within ${maxIterations} iteration(s)`);
    } catch (err) {
      if (!isTerminalRunState(state)) {
        try {
          const terminal: AgentRunState = 'failed';
          assertRunTransition(state, terminal);
          state = terminal;
        } catch {
          state = 'failed';
        }
      }
      emit('failed', { error: err instanceof Error ? err.message : String(err) });
      return finish('failed', err instanceof Error ? err.message : String(err));
    }
  }
}

export function createAgentRunner(deps: AgentRunnerDeps = {}): AgentRunner {
  return new AgentRunner(deps);
}
