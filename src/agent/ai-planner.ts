import type { AIProvider } from '../core/interfaces.js';
import type { RepairPlan } from '../core/models.js';
import { buildAIPlanningContext } from '../ai/context.js';
import { validateAIPlan } from '../ai/validation.js';
import { isAIProviderError } from '../ai/errors.js';
import { createDeterministicRepairPlanner, actionFingerprint } from './deterministic-planner.js';
import type { DeterministicPlan } from './deterministic-planner.js';
import type { PlannerFn } from './runner.js';

export interface AIPlannerCallbacks {
  readonly onFallback?: (reason: string, details?: string) => void;
  readonly onAIResult?: (info: { valid: number; rejections: ReadonlyArray<string> }) => void;
}

interface DeterministicPlannerLike {
  createPlan(input: {
    analysis: Parameters<PlannerFn>[0]['analysis'];
    workspaceRoot: string;
    attemptedFingerprints: ReadonlySet<string>;
  }): Promise<DeterministicPlan>;
}

export function createAIPlanner(
  provider: AIProvider,
  callbacks: AIPlannerCallbacks = {},
  deterministic: DeterministicPlannerLike = createDeterministicRepairPlanner()
): PlannerFn {
  return async (input) => {
    if (provider.type === 'none' || typeof provider.generatePlan !== 'function') {
      callbacks.onFallback?.('ai-unavailable', 'AI unavailable, using deterministic planning');
      const fallback = await deterministic.createPlan(input);
      return { ...fallback, aiUsed: false };
    }

    const context = buildAIPlanningContext({
      observation: input.analysis.observation,
      analysis: input.analysis,
      workspaceRoot: input.workspaceRoot,
      failedFingerprints: input.attemptedFingerprints,
      previousAttempts: input.previousAttempts,
      ...(input.lastReport === undefined ? {} : { lastReport: input.lastReport }),
    });

    let generated;
    try {
      generated = await provider.generatePlan(context);
    } catch (err) {
      const details = isAIProviderError(err) ? `${err.code}: ${err.message}` : 'AI planning failed';
      callbacks.onFallback?.('ai-error', details);
      const fallback = await deterministic.createPlan(input);
      return { ...fallback, aiUsed: false };
    }

    const { valid, rejections } = validateAIPlan(
      generated.actions.map((action) => ({
        type: action.type,
        parameters: action.parameters,
        ...(action.rationale === undefined ? {} : { rationale: action.rationale }),
      })),
      input.workspaceRoot
    );
    callbacks.onAIResult?.({ valid: valid.length, rejections });

    if (valid.length === 0) {
      callbacks.onFallback?.('ai-no-valid-actions', rejections.join('; ') || 'AI proposed no valid actions');
      const fallback = await deterministic.createPlan(input);
      return { ...fallback, aiUsed: false, aiRejections: rejections };
    }

    const seen = new Set<string>();
    const skippedFingerprints: string[] = [];
    const actions = [];
    for (const entry of valid) {
      const fingerprint = actionFingerprint(entry.action);
      if (seen.has(fingerprint)) {
        continue;
      }
      seen.add(fingerprint);
      if (input.attemptedFingerprints.has(fingerprint)) {
        skippedFingerprints.push(fingerprint);
        continue;
      }
      actions.push(entry.action);
    }

    if (actions.length === 0) {
      callbacks.onFallback?.('ai-all-retried', 'All valid AI actions were already attempted');
      const fallback = await deterministic.createPlan(input);
      return { ...fallback, aiUsed: false, aiRejections: rejections };
    }

    const plan: RepairPlan = {
      id: `plan-ai-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name: `AI-assisted repair plan (${provider.name})`,
      description: generated.summary,
      actions,
      estimatedDuration: actions.length * 5000,
      requiresApproval: actions.some((action) => action.permissionLevel !== 'read-only'),
    };

    return { plan, manualActions: [], skippedFingerprints, aiUsed: true, aiRejections: rejections };
  };
}
