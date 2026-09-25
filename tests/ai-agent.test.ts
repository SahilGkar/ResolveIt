import { describe, it, expect, vi } from 'vitest';
import { program } from '../src/cli/index.js';
import { AgentRunner } from '../src/agent/runner.js';
import type { PlanExecutor } from '../src/agent/runner.js';
import { createAIPlanner } from '../src/agent/index.js';
import { ExternalAIProvider } from '../src/ai/index.js';
import { AIProviderError } from '../src/ai/index.js';
import type { FetchImpl } from '../src/ai/index.js';
import type {
  AIProvider,
  AIPlanningContext,
  AIPlanningResult,
  Diagnostic,
  RepairPlan,
} from '../src/core/models.js';
import type { AgentAnalysis } from '../src/agent/index.js';

function observation(): never {
  return {
    workspace: {
      id: 'ws-1',
      rootPath: '/tmp/ws',
      projects: [],
      environments: [],
      allFiles: [],
      allDirectories: [],
      languages: [],
      projectMarkers: [],
      configFiles: [],
      repoIndicators: [],
      errors: [],
    },
    environment: {
      os: { platform: 'linux', architecture: 'x64', hostname: 'test' },
      runtimes: [],
      devTools: [],
      packageManagers: [],
      containers: {
        docker: { name: 'docker', command: 'docker', available: false },
        dockerCompose: { name: 'docker-compose', command: 'docker-compose', available: false },
        dockerRunning: false,
      },
      environmentVariables: {},
      scannedAt: new Date(),
    },
    requirements: [],
    timestamp: new Date(),
  } as never;
}

function toolDiag(): Diagnostic {
  return {
    id: 'diag-tool',
    code: 'TOOL_TOOLCHAIN_MISMATCH',
    severity: 'error',
    category: 'toolchain',
    title: 'eslint tool issue',
    message: 'eslint is not available',
    evidence: [],
    affectedFiles: ['package.json'],
    requirement: {
      id: 'req-1',
      ecosystem: 'node',
      type: 'system-tool',
      name: 'eslint',
      sourceFile: 'package.json',
    },
    source: 'dependency-resolver',
    timestamp: new Date(),
    metadata: {},
  };
}

function depDiag(name = 'lodash'): Diagnostic {
  return {
    id: `diag-${name}`,
    code: 'DEPENDENCY_PACKAGE-DEPENDENCY_MISMATCH',
    severity: 'error',
    category: 'dependency',
    title: `Dependency: ${name}`,
    message: `${name} is missing`,
    evidence: [],
    affectedFiles: ['package.json'],
    requirement: {
      id: `req-${name}`,
      ecosystem: 'node',
      type: 'package-dependency',
      name,
      versionConstraint: '^1.0.0',
      sourceFile: 'package.json',
    },
    source: 'dependency-resolver',
    timestamp: new Date(),
    metadata: {},
  };
}

function analysisWith(diagnostics: Diagnostic[]): AgentAnalysis {
  const obs = observation() as never;
  return {
    observation: obs,
    diagnostics,
    blockingDiagnostics: diagnostics,
    timestamp: new Date(),
  };
}

function stubProvider(
  generatePlan: (context: AIPlanningContext) => Promise<AIPlanningResult>,
  type: AIProvider['type'] = 'external'
): AIProvider {
  return {
    type,
    name: 'Stub AI Provider',
    version: '0.0.1',
    isAvailable: () => Promise.resolve(true),
    diagnose: () =>
      Promise.resolve({ id: 'd', summary: 'stub', rootCauses: [], confidence: 0, timestamp: new Date() }),
    planRepair: () =>
      Promise.resolve({ id: 'p', name: 'stub', description: 'stub', actions: [], requiresApproval: false }),
    generatePlan,
  };
}

function mockExecutor(fail = false): PlanExecutor & { calls: RepairPlan[] } {
  const calls: RepairPlan[] = [];
  return {
    calls,
    executePlan: (plan) => {
      calls.push(plan);
      return Promise.resolve({
        results: plan.actions.map((action) => ({
          action,
          result: fail ? { success: false, error: 'mocked failure' } : { success: true, output: 'ok', modifiedFiles: [] },
        })),
        success: !fail,
      });
    },
  };
}

describe('AI agent integration', () => {
  it('should use the AI planner when AI proposes valid actions', async () => {
    const provider = stubProvider(() =>
      Promise.resolve({
        summary: 'Install lodash via npm',
        actions: [{ type: 'install-dependency', parameters: { ecosystem: 'npm', package: 'lodash' } }],
      })
    );
    const fallbacks: string[] = [];
    const runner = new AgentRunner({
      observe: () => Promise.resolve(observation()),
      analyze: (obs) => Promise.resolve({ ...analysisWith([toolDiag()]), observation: obs }),
      plan: createAIPlanner(provider, { onFallback: (reason) => fallbacks.push(reason) }),
      executorFactory: () => mockExecutor(),
    });
    const { context, result } = await runner.run({ workspaceRoot: '/tmp/ws', dryRun: true });
    expect(result.status).toBe('awaiting-approval');
    expect(context.plans).toHaveLength(1);
    expect(context.plans[0]?.aiUsed).toBe(true);
    expect(context.plans[0]?.plan.actions).toHaveLength(1);
    expect(context.plans[0]?.plan.actions[0]?.type).toBe('install-dependency');
    expect(context.plans[0]?.plan.requiresApproval).toBe(true);
    expect(context.plans[0]?.manualActions).toHaveLength(0);
    expect(fallbacks).toHaveLength(0);
  });

  it('should fall back to deterministic planning when AI is unavailable', async () => {
    const provider = stubProvider(() => Promise.reject(new AIProviderError('unavailable', 'down')));
    const fallbacks: Array<{ reason: string; details?: string }> = [];
    const runner = new AgentRunner({
      observe: () => Promise.resolve(observation()),
      analyze: (obs) => Promise.resolve({ ...analysisWith([depDiag()]), observation: obs }),
      plan: createAIPlanner(provider, { onFallback: (reason, details) => fallbacks.push({ reason, details }) }),
      executorFactory: () => mockExecutor(),
    });
    const { context, result } = await runner.run({ workspaceRoot: '/tmp/ws', dryRun: true });
    expect(result.status).toBe('awaiting-approval');
    expect(context.plans[0]?.aiUsed).toBe(false);
    expect(context.plans[0]?.plan.actions).toHaveLength(1);
    expect(fallbacks[0]?.reason).toBe('ai-error');
  });

  it('should fall back when AI output is malformed', async () => {
    const provider = stubProvider(() => Promise.reject(new AIProviderError('malformed', 'bad json')));
    const fallbacks: string[] = [];
    const runner = new AgentRunner({
      observe: () => Promise.resolve(observation()),
      analyze: (obs) => Promise.resolve({ ...analysisWith([depDiag()]), observation: obs }),
      plan: createAIPlanner(provider, { onFallback: (reason) => fallbacks.push(reason) }),
      executorFactory: () => mockExecutor(),
    });
    const { context } = await runner.run({ workspaceRoot: '/tmp/ws', dryRun: true });
    expect(context.plans[0]?.aiUsed).toBe(false);
    expect(context.plans[0]?.plan.actions).toHaveLength(1);
    expect(fallbacks).toContain('ai-error');
  });

  it('should reject unsafe AI actions and fall back when none are valid', async () => {
    const provider = stubProvider(() =>
      Promise.resolve({
        summary: 'evil plan',
        actions: [{ type: 'create-file', parameters: { path: '../evil.txt', content: 'x' } }],
      })
    );
    const runner = new AgentRunner({
      observe: () => Promise.resolve(observation()),
      analyze: (obs) => Promise.resolve({ ...analysisWith([depDiag()]), observation: obs }),
      plan: createAIPlanner(provider),
      executorFactory: () => mockExecutor(),
    });
    const { context } = await runner.run({ workspaceRoot: '/tmp/ws', dryRun: true });
    expect(context.plans[0]?.aiUsed).toBe(false);
    expect(context.plans[0]?.aiRejections?.length).toBeGreaterThan(0);
    expect(context.plans[0]?.plan.actions).toHaveLength(1);
    expect((context.plans[0]?.plan.actions[0]?.parameters as Record<string, unknown>)?.['package']).toBe('lodash');
  });

  it('should still enforce Phase 5 approval for AI-proposed actions', async () => {
    const provider = stubProvider(() =>
      Promise.resolve({
        summary: 'Install lodash',
        actions: [{ type: 'install-dependency', parameters: { ecosystem: 'npm', package: 'lodash' } }],
      })
    );
    const build = (executor: PlanExecutor & { calls: RepairPlan[] }): AgentRunner =>
      new AgentRunner({
        observe: () => Promise.resolve(observation()),
        analyze: (obs) => Promise.resolve({ ...analysisWith([depDiag()]), observation: obs }),
        plan: createAIPlanner(provider),
        executorFactory: () => executor,
        verifier: {
          verifyPlan: () =>
            Promise.resolve({
              success: true,
              diagnostics: [],
              resolvedDiagnostics: ['k'],
              remainingDiagnostics: [],
              evidence: [],
              summary: 'verified',
            }),
        },
      });

    const deniedExecutor = mockExecutor();
    const denied = await build(deniedExecutor).run({
      workspaceRoot: '/tmp/ws',
      approvalCallback: () => Promise.resolve([]),
    });
    expect(denied.result.status).toBe('failed');
    expect(deniedExecutor.calls).toHaveLength(0);

    const allowedExecutor = mockExecutor();
    const allowed = await build(allowedExecutor).run({
      workspaceRoot: '/tmp/ws',
      approvalCallback: (plan) => Promise.resolve(plan.actions.map((a) => a.id)),
    });
    expect(allowed.result.status).toBe('resolved');
    expect(allowedExecutor.calls).toHaveLength(1);
    expect(allowed.context.executedActions[0]?.action.permissionLevel).toBe('project-modification');
  });

  it('should feed new verification evidence to the AI planner on re-plan', async () => {
    const seen: AIPlanningContext[] = [];
    const provider = stubProvider((context) => {
      seen.push(context);
      return Promise.resolve({
        summary: 'Install pkg',
        actions: [{ type: 'install-dependency', parameters: { ecosystem: 'npm', package: `pkg-${seen.length}` } }],
      });
    });
    const runner = new AgentRunner({
      observe: () => Promise.resolve(observation()),
      analyze: (obs) => Promise.resolve({ ...analysisWith([depDiag('stubborn')]), observation: obs }),
      plan: createAIPlanner(provider),
      executorFactory: () => mockExecutor(true),
      verifier: {
        verifyPlan: () =>
          Promise.resolve({
            success: false,
            diagnostics: [],
            resolvedDiagnostics: [],
            remainingDiagnostics: ['dependency|stubborn'],
            evidence: [],
            summary: 'still broken',
          }),
      },
    });
    const { result } = await runner.run({
      workspaceRoot: '/tmp/ws',
      maxIterations: 2,
      approvalCallback: (plan) => Promise.resolve(plan.actions.map((a) => a.id)),
    });
    expect(result.status).toBe('failed');
    expect(seen).toHaveLength(2);
    expect(seen[0]?.verification).toBeUndefined();
    expect(seen[0]?.previousAttempts).toHaveLength(0);
    expect(seen[1]?.verification?.success).toBe(false);
    expect(seen[1]?.verification?.remainingDiagnostics).toEqual(['dependency|stubborn']);
    expect(seen[1]?.previousAttempts).toHaveLength(1);
    expect(seen[1]?.previousAttempts[0]?.success).toBe(false);
  });

  it('should use deterministic planning for providers without structured planning', async () => {
    const fallbacks: string[] = [];
    const noAI = stubProvider(undefined as never, 'none');
    delete (noAI as Partial<AIProvider>).generatePlan;
    const runner = new AgentRunner({
      observe: () => Promise.resolve(observation()),
      analyze: (obs) => Promise.resolve({ ...analysisWith([depDiag()]), observation: obs }),
      plan: createAIPlanner(noAI, { onFallback: (reason) => fallbacks.push(reason) }),
      executorFactory: () => mockExecutor(),
    });
    const { context } = await runner.run({ workspaceRoot: '/tmp/ws', dryRun: true });
    expect(context.plans[0]?.aiUsed).toBe(false);
    expect(context.plans[0]?.plan.actions).toHaveLength(1);
    expect(fallbacks).toContain('ai-unavailable');
  });
});

describe('AI security boundaries', () => {
  const SECRET = 'test-secret-key-12345';

  it('should keep API keys out of prompts, contexts, events, and errors', async () => {
    let seenBody = '';
    const fetchImpl: FetchImpl = (_url, options) => {
      seenBody = options?.body ?? '';
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Install lodash',
                      actions: [{ type: 'install-dependency', parameters: { ecosystem: 'npm', package: 'lodash' } }],
                    }),
                  },
                },
              ],
            })
          ),
      });
    };
    const provider = new ExternalAIProvider(
      { provider: 'external', model: 'm', baseUrl: 'https://api.example/v1', apiKey: SECRET },
      { fetchImpl }
    );
    const events: Array<{ type: string }> = [];
    const runner = new AgentRunner({
      observe: () => Promise.resolve(observation()),
      analyze: (obs) => Promise.resolve({ ...analysisWith([depDiag()]), observation: obs }),
      plan: createAIPlanner(provider),
      executorFactory: () => mockExecutor(),
      onEvent: (event) => {
        events.push(event);
      },
    });
    const { context } = await runner.run({ workspaceRoot: '/tmp/ws', dryRun: true });
    expect(seenBody).not.toContain(SECRET);
    expect(JSON.stringify(context)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it('should not leak API keys in provider errors', async () => {
    const provider = new ExternalAIProvider(
      { provider: 'external', model: 'm', baseUrl: 'https://api.example/v1', apiKey: SECRET },
      {
        fetchImpl: () => Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve('denied') }),
      }
    );
    const error = await provider.generatePlan({
      workspaceSummary: { rootPath: '/tmp/ws', projectCount: 0, projects: [], languages: [] },
      environmentSummary: { runtimes: [], tools: [], dockerAvailable: false, dockerRunning: false },
      requirements: [],
      diagnostics: [],
      availableTools: [],
      constraints: {
        maxRiskLevel: 'project-modification',
        allowedActions: [],
        systemModificationRequiresApproval: true,
      },
      previousAttempts: [],
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AIProviderError);
    expect((error as Error).message).not.toContain(SECRET);
  });

  it('should prevent AI from bypassing approval or changing permissions', async () => {
    const sneaky = stubProvider(() =>
      Promise.resolve({
        summary: 'sneaky',
        actions: [
          { type: 'install-dependency', parameters: { ecosystem: 'npm', package: 'lodash', permissionLevel: 'read-only' } },
        ],
      })
    );
    const executor = mockExecutor();
    const runner = new AgentRunner({
      observe: () => Promise.resolve(observation()),
      analyze: (obs) => Promise.resolve({ ...analysisWith([depDiag()]), observation: obs }),
      plan: createAIPlanner(sneaky),
      executorFactory: () => executor,
    });
    const { context } = await runner.run({ workspaceRoot: '/tmp/ws', dryRun: true });
    expect(context.plans[0]?.aiUsed).toBe(false);
    expect(context.plans[0]?.aiRejections?.join(' ')).toContain('escalation');
  });

  it('should ensure malformed AI output can never execute', async () => {
    const garbage = stubProvider(() => Promise.reject(new AIProviderError('malformed', 'bad output')));
    const executor = mockExecutor();
    const runner = new AgentRunner({
      observe: () => Promise.resolve(observation()),
      analyze: (obs) => Promise.resolve({ ...analysisWith([depDiag()]), observation: obs }),
      plan: createAIPlanner(garbage),
      executorFactory: () => executor,
    });
    const { context, result } = await runner.run({
      workspaceRoot: '/tmp/ws',
      approvalCallback: (plan) => Promise.resolve(plan.actions.map((a) => a.id)),
      verifier: undefined,
    } as never);
    expect(result.status === 'resolved' || result.status === 'failed').toBe(true);
    for (const call of executor.calls) {
      for (const action of call.actions) {
        expect(action.type).toBe('install-dependency');
      }
    }
    expect(JSON.stringify(context)).not.toContain('garbage-output-should-never-appear');
  });
});

describe('AI CLI surface', () => {
  it('should expose the ai command', () => {
    expect(program.commands.find((c) => c.name() === 'ai')).toBeDefined();
  });

  it('should expose AI options on the run command', () => {
    const run = program.commands.find((c) => c.name() === 'run');
    const flags = run?.options.map((o) => o.long) ?? [];
    expect(flags).toContain('--ai');
    expect(flags).toContain('--ai-model');
    expect(flags).toContain('--ai-base-url');
  });
});
