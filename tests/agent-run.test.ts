import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import {
  AGENT_RUN_STATES,
  AGENT_RUN_TRANSITIONS,
  canTransitionRunState,
  assertRunTransition,
  isTerminalRunState,
  toLifecycleStage,
} from '../src/agent/run-state.js';
import type { AgentRunState } from '../src/agent/run-state.js';
import { observeWorkspace } from '../src/agent/observation.js';
import { analyzeObservation, isBlockingDiagnostic, diagnosticKey } from '../src/agent/analysis.js';
import type { AgentAnalysis, AgentObservation } from '../src/agent/index.js';
import {
  DeterministicRepairPlanner,
  actionFingerprint,
  MISSING_REQUIRED_FILE_CODE,
} from '../src/agent/deterministic-planner.js';
import { VerificationEngineImpl, targetedCheck } from '../src/agent/verifier.js';
import { AgentRunner } from '../src/agent/runner.js';
import type { PlanExecutor } from '../src/agent/runner.js';
import type {
  Diagnostic,
  DiagnosticSeverity,
  ProjectRequirement,
  RepairAction,
  RepairPlan,
  RiskLevel,
} from '../src/core/models.js';

const testWorkspace = join(tmpdir(), 'resolveit-agent-run-');

function requirement(overrides: Partial<ProjectRequirement> = {}): ProjectRequirement {
  return {
    id: 'req-1',
    ecosystem: 'node',
    type: 'package-dependency',
    name: 'lodash',
    versionConstraint: '^4.17.21',
    sourceFile: 'package.json',
    ...overrides,
  };
}

function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    id: 'diag-1',
    code: 'DEPENDENCY_PACKAGE-DEPENDENCY_MISMATCH',
    severity: 'error' as DiagnosticSeverity,
    category: 'dependency',
    title: 'Dependency: lodash',
    message: 'lodash is missing',
    evidence: [],
    affectedFiles: ['package.json'],
    requirement: requirement(),
    source: 'dependency-resolver',
    timestamp: new Date(),
    metadata: {},
    ...overrides,
  };
}

function emptyObservation(): AgentObservation {
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
  };
}

function analysisWith(diagnostics: Diagnostic[]): AgentAnalysis {
  const obs = emptyObservation();
  return {
    observation: obs,
    diagnostics,
    blockingDiagnostics: diagnostics.filter(isBlockingDiagnostic),
    timestamp: new Date(),
  };
}

function mockExecutor(
  behavior: (plan: RepairPlan) => { success: boolean; error?: string }
): PlanExecutor & { calls: RepairPlan[] } {
  const calls: RepairPlan[] = [];
  return {
    calls,
    executePlan: (plan) => {
      calls.push(plan);
      const outcome = behavior(plan);
      return Promise.resolve({
        results: plan.actions.map((action) => ({
          action,
          result: outcome.success
            ? { success: true, output: 'mocked ok', modifiedFiles: [] }
            : { success: false, error: outcome.error ?? 'mocked failure' },
        })),
        success: outcome.success,
      });
    },
  };
}

describe('agent run state machine', () => {
  it('should define all lifecycle states', () => {
    expect(AGENT_RUN_STATES).toEqual([
      'idle',
      'observing',
      'analyzing',
      'planning',
      'awaiting-approval',
      'acting',
      'verifying',
      'resolved',
      'replanning',
      'failed',
    ]);
  });

  it('should allow the happy-path transitions', () => {
    const path: AgentRunState[] = [
      'idle',
      'observing',
      'analyzing',
      'planning',
      'awaiting-approval',
      'acting',
      'verifying',
      'resolved',
    ];
    for (let i = 1; i < path.length; i++) {
      expect(canTransitionRunState(path[i - 1] as AgentRunState, path[i] as AgentRunState)).toBe(true);
    }
  });

  it('should allow the re-planning loop transitions', () => {
    expect(canTransitionRunState('verifying', 'replanning')).toBe(true);
    expect(canTransitionRunState('replanning', 'analyzing')).toBe(true);
    expect(canTransitionRunState('verifying', 'failed')).toBe(true);
    expect(canTransitionRunState('analyzing', 'resolved')).toBe(true);
  });

  it('should reject arbitrary state jumps', () => {
    expect(canTransitionRunState('idle', 'planning')).toBe(false);
    expect(canTransitionRunState('observing', 'acting')).toBe(false);
    expect(canTransitionRunState('acting', 'resolved')).toBe(false);
    expect(canTransitionRunState('resolved', 'observing')).toBe(false);
    expect(canTransitionRunState('failed', 'analyzing')).toBe(false);
    expect(canTransitionRunState('planning', 'acting')).toBe(false);
    expect(() => assertRunTransition('idle', 'planning')).toThrow('Invalid agent run transition');
  });

  it('should identify terminal states', () => {
    expect(isTerminalRunState('resolved')).toBe(true);
    expect(isTerminalRunState('failed')).toBe(true);
    expect(isTerminalRunState('verifying')).toBe(false);
    expect(isTerminalRunState('awaiting-approval')).toBe(false);
  });

  it('should map run states onto legacy lifecycle stages', () => {
    expect(toLifecycleStage('idle')).toBe('observe');
    expect(toLifecycleStage('observing')).toBe('observe');
    expect(toLifecycleStage('analyzing')).toBe('analyze');
    expect(toLifecycleStage('planning')).toBe('plan');
    expect(toLifecycleStage('awaiting-approval')).toBe('request-approval');
    expect(toLifecycleStage('acting')).toBe('act');
    expect(toLifecycleStage('verifying')).toBe('verify');
    expect(toLifecycleStage('resolved')).toBe('resolved');
    expect(toLifecycleStage('replanning')).toBe('re-plan');
    expect(toLifecycleStage('failed')).toBe('failed');
  });

  it('should expose transitions for every state', () => {
    for (const state of AGENT_RUN_STATES) {
      expect(AGENT_RUN_TRANSITIONS[state]).toBeDefined();
    }
  });
});

describe('agent observation', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(testWorkspace);
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('should produce structured output reusing scanners', async () => {
    const observation = await observeWorkspace(workspaceRoot, 15000);
    expect(observation.workspace.rootPath).toContain('resolveit-agent-run-');
    expect(observation.environment).toBeDefined();
    expect(Array.isArray(observation.requirements)).toBe(true);
    expect(observation.timestamp).toBeInstanceOf(Date);
  }, 30000);
});

describe('agent analysis', () => {
  it('should classify blocking diagnostics', () => {
    expect(isBlockingDiagnostic(diagnostic({ severity: 'error' }))).toBe(true);
    expect(isBlockingDiagnostic(diagnostic({ severity: 'critical' }))).toBe(true);
    expect(isBlockingDiagnostic(diagnostic({ severity: 'warning' }))).toBe(false);
    expect(isBlockingDiagnostic(diagnostic({ severity: 'info' }))).toBe(false);
    expect(isBlockingDiagnostic(diagnostic({ severity: 'hint' }))).toBe(false);
  });

  it('should generate stable diagnostic keys', () => {
    const a = diagnostic();
    const b = diagnostic({ id: 'different-id', timestamp: new Date(0) });
    expect(diagnosticKey(a)).toBe(diagnosticKey(b));
    expect(diagnosticKey(diagnostic({ requirement: requirement({ name: 'other' }) }))).not.toBe(
      diagnosticKey(a)
    );
  });

  it('should analyze an empty workspace with no diagnostics', async () => {
    const analysis = await analyzeObservation(emptyObservation());
    expect(analysis.diagnostics).toHaveLength(0);
    expect(analysis.blockingDiagnostics).toHaveLength(0);
  });
});

describe('deterministic planner', () => {
  const planner = new DeterministicRepairPlanner();

  it('should map a missing npm dependency to install-dependency', async () => {
    const result = await planner.createPlan({
      analysis: analysisWith([diagnostic()]),
      workspaceRoot: '/tmp/ws',
    });
    expect(result.plan.actions).toHaveLength(1);
    expect(result.plan.actions[0]?.type).toBe('install-dependency');
    expect(result.plan.actions[0]?.permissionLevel).toBe('project-modification');
    expect((result.plan.actions[0]?.parameters as Record<string, unknown>)['ecosystem']).toBe('npm');
    expect((result.plan.actions[0]?.parameters as Record<string, unknown>)['workspaceRoot']).toBe('/tmp/ws');
    expect(result.plan.requiresApproval).toBe(true);
    expect(result.manualActions).toHaveLength(0);
  });

  it('should return manual action for unsupported ecosystems', async () => {
    const result = await planner.createPlan({
      analysis: analysisWith([diagnostic({ requirement: requirement({ ecosystem: 'java', name: 'junit' }) })]),
      workspaceRoot: '/tmp/ws',
    });
    expect(result.plan.actions).toHaveLength(0);
    expect(result.manualActions).toHaveLength(1);
    expect(result.manualActions[0]?.riskLevel).toBe('project-modification');
  });

  it('should return system-level manual action for runtime mismatches', async () => {
    const runtimeDiag = diagnostic({
      code: 'RUNTIME_RUNTIME-VERSION_MISMATCH',
      category: 'runtime',
      requirement: requirement({ type: 'runtime-version', name: 'node', versionConstraint: '>=99.0.0' }),
    });
    const result = await planner.createPlan({ analysis: analysisWith([runtimeDiag]), workspaceRoot: '/tmp/ws' });
    expect(result.plan.actions).toHaveLength(0);
    expect(result.manualActions).toHaveLength(1);
    expect(result.manualActions[0]?.riskLevel).toBe('system-modification');
  });

  it('should return manual action for missing tools', async () => {
    const toolDiag = diagnostic({
      code: 'TOOL_TOOLCHAIN_MISMATCH',
      category: 'toolchain',
      requirement: requirement({ type: 'system-tool', name: 'eslint' }),
    });
    const result = await planner.createPlan({ analysis: analysisWith([toolDiag]), workspaceRoot: '/tmp/ws' });
    expect(result.plan.actions).toHaveLength(0);
    expect(result.manualActions[0]?.riskLevel).toBe('system-modification');
  });

  it('should map required-file diagnostics to controlled create-file actions', async () => {
    const fileDiag = diagnostic({
      code: MISSING_REQUIRED_FILE_CODE,
      category: 'project',
      requirement: undefined,
      affectedFiles: ['hello.txt'],
      remediationCandidates: [
        {
          id: 'rem-1',
          type: 'create-environment',
          description: 'Create hello.txt',
          confidence: 1,
          riskLevel: 'project-modification' as RiskLevel,
          payload: { path: 'hello.txt', content: 'hello' },
        },
      ],
    });
    const result = await planner.createPlan({ analysis: analysisWith([fileDiag]), workspaceRoot: '/tmp/ws' });
    expect(result.plan.actions).toHaveLength(1);
    expect((result.plan.actions[0]?.parameters as Record<string, unknown>)['path']).toBe('hello.txt');
    expect((result.plan.actions[0]?.parameters as Record<string, unknown>)['content']).toBe('hello');
  });

  it('should reject unsafe file payloads as manual instead', async () => {
    const fileDiag = diagnostic({
      code: MISSING_REQUIRED_FILE_CODE,
      category: 'project',
      requirement: undefined,
      remediationCandidates: [
        {
          id: 'rem-1',
          type: 'create-environment',
          description: 'evil',
          confidence: 1,
          riskLevel: 'project-modification' as RiskLevel,
          payload: { path: '../evil.txt', content: 'x' },
        },
      ],
    });
    const result = await planner.createPlan({ analysis: analysisWith([fileDiag]), workspaceRoot: '/tmp/ws' });
    expect(result.plan.actions).toHaveLength(0);
    expect(result.manualActions).toHaveLength(1);
  });

  it('should never emit arbitrary commands', async () => {
    const diags = [
      diagnostic(),
      diagnostic({
        id: 'diag-2',
        code: 'RUNTIME_X',
        category: 'runtime',
        requirement: requirement({ type: 'runtime-version', name: 'node' }),
      }),
    ];
    const result = await planner.createPlan({ analysis: analysisWith(diags), workspaceRoot: '/tmp/ws' });
    const allowed = new Set(['install-dependency', 'create-environment', 'modify-configuration']);
    for (const action of result.plan.actions) {
      expect(allowed.has(action.type)).toBe(true);
    }
  });

  it('should exclude already-attempted fingerprints', async () => {
    const first = await planner.createPlan({ analysis: analysisWith([diagnostic()]), workspaceRoot: '/tmp/ws' });
    const fingerprint = actionFingerprint(first.plan.actions[0] as RepairAction);
    const second = await planner.createPlan({
      analysis: analysisWith([diagnostic()]),
      workspaceRoot: '/tmp/ws',
      attemptedFingerprints: new Set([fingerprint]),
    });
    expect(second.plan.actions).toHaveLength(0);
    expect(second.skippedFingerprints).toContain(fingerprint);
  });

  it('should produce stable fingerprints excluding workspace root', () => {
    const action = {
      type: 'install-dependency',
      target: { filePath: 'package.json' },
      parameters: { ecosystem: 'npm', package: 'lodash', workspaceRoot: '/tmp/a' },
    } as RepairAction;
    const other = {
      type: 'install-dependency',
      target: { filePath: 'package.json' },
      parameters: { ecosystem: 'npm', package: 'lodash', workspaceRoot: '/tmp/b' },
    } as RepairAction;
    expect(actionFingerprint(action)).toBe(actionFingerprint(other));
  });
});

describe('agent approval boundary', () => {
  it('should not execute denied actions', async () => {
    const executor = mockExecutor(() => ({ success: true }));
    const runner = new AgentRunner({
      observe: () => Promise.resolve(emptyObservation()),
      analyze: () => Promise.resolve(analysisWith([diagnostic()])),
      executorFactory: () => executor,
    });
    const { context, result } = await runner.run({
      workspaceRoot: '/tmp/ws',
      approvalCallback: () => Promise.resolve([]),
    });
    expect(executor.calls).toHaveLength(0);
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('denied');
    expect(context.state).toBe('failed');
  });

  it('should deny everything when no approval callback is provided', async () => {
    const executor = mockExecutor(() => ({ success: true }));
    const runner = new AgentRunner({
      observe: () => Promise.resolve(emptyObservation()),
      analyze: () => Promise.resolve(analysisWith([diagnostic()])),
      executorFactory: () => executor,
    });
    const { result } = await runner.run({ workspaceRoot: '/tmp/ws' });
    expect(executor.calls).toHaveLength(0);
    expect(result.status).toBe('failed');
  });

  it('should stop at the approval boundary in dry-run mode', async () => {
    const executor = mockExecutor(() => ({ success: true }));
    const approvalCallback = vi.fn();
    const runner = new AgentRunner({
      observe: () => Promise.resolve(emptyObservation()),
      analyze: () => Promise.resolve(analysisWith([diagnostic()])),
      executorFactory: () => executor,
    });
    const { context, result } = await runner.run({
      workspaceRoot: '/tmp/ws',
      dryRun: true,
      approvalCallback,
    });
    expect(result.status).toBe('awaiting-approval');
    expect(context.state).toBe('awaiting-approval');
    expect(approvalCallback).not.toHaveBeenCalled();
    expect(executor.calls).toHaveLength(0);
  });
});

describe('agent execution', () => {
  it('should record successful executions', async () => {
    const executor = mockExecutor(() => ({ success: true }));
    const runner = new AgentRunner({
      observe: () => Promise.resolve(emptyObservation()),
      analyze: (obs) =>
        Promise.resolve({
          observation: obs,
          diagnostics: [],
          blockingDiagnostics: [],
          timestamp: new Date(),
        }),
      executorFactory: () => executor,
    });
    const { context, result } = await runner.run({
      workspaceRoot: '/tmp/ws',
      approvalCallback: (plan) => Promise.resolve(plan.actions.map((a) => a.id)),
    });
    expect(result.status).toBe('resolved');
    expect(context.executedActions).toHaveLength(0);
  });

  it('should record failed actions with fingerprints', async () => {
    const executor = mockExecutor(() => ({ success: false, error: 'boom' }));
    let calls = 0;
    const runner = new AgentRunner({
      observe: () => Promise.resolve(emptyObservation()),
      analyze: () => {
        calls += 1;
        return Promise.resolve(analysisWith([diagnostic()]));
      },
      executorFactory: () => executor,
      verifier: {
        verifyPlan: () =>
          Promise.resolve({
            success: false,
            diagnostics: [],
            resolvedDiagnostics: [],
            remainingDiagnostics: ['dependency|x'],
            evidence: [],
            summary: 'still broken',
          }),
      },
    });
    const { context, result } = await runner.run({
      workspaceRoot: '/tmp/ws',
      maxIterations: 1,
      approvalCallback: (plan) => Promise.resolve(plan.actions.map((a) => a.id)),
    });
    expect(result.status).toBe('failed');
    expect(context.executedActions).toHaveLength(1);
    expect(context.executedActions[0]?.result.success).toBe(false);
    expect(context.failedFingerprints).toHaveLength(1);
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});

describe('verification engine', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(testWorkspace);
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('should report resolved when blocking diagnostics disappear', async () => {
    const engine = new VerificationEngineImpl();
    const before = analysisWith([diagnostic()]);
    const after = analysisWith([]);
    const report = await engine.verifyPlan([], before, after, workspaceRoot);
    expect(report.success).toBe(true);
    expect(report.resolvedDiagnostics).toHaveLength(1);
    expect(report.remainingDiagnostics).toHaveLength(0);
  });

  it('should report remaining diagnostics', async () => {
    const engine = new VerificationEngineImpl();
    const before = analysisWith([diagnostic()]);
    const after = analysisWith([diagnostic()]);
    const report = await engine.verifyPlan([], before, after, workspaceRoot);
    expect(report.success).toBe(false);
    expect(report.remainingDiagnostics).toHaveLength(1);
    expect(report.resolvedDiagnostics).toHaveLength(0);
  });

  it('should verify created files with targeted checks', async () => {
    const action = {
      id: 'action-1',
      type: 'create-environment',
      target: {},
      parameters: { path: 'hello.txt', content: 'hello', workspaceRoot },
    } as RepairAction;
    await fs.writeFile(join(workspaceRoot, 'hello.txt'), 'hello', 'utf-8');
    const check = await targetedCheck(action, { success: true }, workspaceRoot);
    expect(check.passed).toBe(true);
  });

  it('should fail targeted checks when content differs', async () => {
    const action = {
      id: 'action-1',
      type: 'create-environment',
      target: {},
      parameters: { path: 'hello.txt', content: 'expected', workspaceRoot },
    } as RepairAction;
    await fs.writeFile(join(workspaceRoot, 'hello.txt'), 'actual', 'utf-8');
    const check = await targetedCheck(action, { success: true }, workspaceRoot);
    expect(check.passed).toBe(false);
  });

  it('should verify single actions through the Phase 0 interface', async () => {
    const engine = new VerificationEngineImpl();
    await fs.writeFile(join(workspaceRoot, 'hello.txt'), 'hello', 'utf-8');
    const action = {
      id: 'action-1',
      type: 'create-environment',
      target: {},
      parameters: { path: 'hello.txt', content: 'hello', workspaceRoot },
    } as RepairAction;
    const result = await engine.verify(action, {
      workspace: emptyObservation().workspace,
      originalDiagnostics: [],
    });
    expect(result.actionId).toBe('action-1');
    expect(result.success).toBe(true);
  });

  it('should honor custom verification rules', async () => {
    const engine = new VerificationEngineImpl();
    engine.registerVerificationRule({
      id: 'always-fail',
      name: 'Always fail',
      applicableActionTypes: ['install-dependency'],
      verify: () =>
        Promise.resolve({
          repairPlanId: '',
          actionId: 'action-1',
          success: false,
          diagnostics: [],
          timestamp: new Date(),
          metadata: {},
        }),
    });
    const action = {
      id: 'action-1',
      type: 'install-dependency',
      target: {},
      parameters: { ecosystem: 'npm', package: 'lodash', workspaceRoot },
    } as RepairAction;
    const result = await engine.verify(action, {
      workspace: emptyObservation().workspace,
      originalDiagnostics: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('agent re-planning and loop prevention', () => {
  it('should re-observe with new evidence after failed verification', async () => {
    let observations = 0;
    let analyses = 0;
    const executor = mockExecutor(() => ({ success: true }));
    const runner = new AgentRunner({
      observe: () => {
        observations += 1;
        return Promise.resolve(emptyObservation());
      },
      analyze: (obs) => {
        analyses += 1;
        return Promise.resolve(analysisWith(analyses === 1 ? [diagnostic()] : []));
      },
      executorFactory: () => executor,
    });
    const { result } = await runner.run({
      workspaceRoot: '/tmp/ws',
      approvalCallback: (plan) => Promise.resolve(plan.actions.map((a) => a.id)),
    });
    expect(observations).toBe(2);
    expect(analyses).toBe(2);
    expect(result.status).toBe('resolved');
    expect(result.iterations).toBe(1);
  });

  it('should block repeated identical actions', async () => {
    const executor = mockExecutor(() => ({ success: false, error: 'nope' }));
    const runner = new AgentRunner({
      observe: () => Promise.resolve(emptyObservation()),
      analyze: () => Promise.resolve(analysisWith([diagnostic()])),
      executorFactory: () => executor,
      verifier: {
        verifyPlan: () =>
          Promise.resolve({
            success: false,
            diagnostics: [],
            resolvedDiagnostics: [],
            remainingDiagnostics: ['dependency|x'],
            evidence: [],
            summary: 'still broken',
          }),
      },
    });
    const { context, result } = await runner.run({
      workspaceRoot: '/tmp/ws',
      maxIterations: 3,
      approvalCallback: (plan) => Promise.resolve(plan.actions.map((a) => a.id)),
    });
    expect(executor.calls).toHaveLength(1);
    expect(result.status).toBe('failed');
    expect(context.plans[1]?.plan.actions ?? []).toHaveLength(0);
  });

  it('should enforce maximum iterations', async () => {
    let n = 0;
    const executor = mockExecutor(() => ({ success: false, error: 'nope' }));
    const runner = new AgentRunner({
      observe: () => Promise.resolve(emptyObservation()),
      analyze: (obs) => {
        n += 1;
        return Promise.resolve(
          analysisWith([diagnostic({ id: `diag-${n}`, requirement: requirement({ name: `pkg-${n}` }) })])
        );
      },
      executorFactory: () => executor,
      verifier: {
        verifyPlan: () =>
          Promise.resolve({
            success: false,
            diagnostics: [],
            resolvedDiagnostics: [],
            remainingDiagnostics: ['dependency|x'],
            evidence: [],
            summary: 'still broken',
          }),
      },
    });
    const { context, result } = await runner.run({
      workspaceRoot: '/tmp/ws',
      maxIterations: 2,
      approvalCallback: (plan) => Promise.resolve(plan.actions.map((a) => a.id)),
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('2 iteration(s)');
    expect(context.state).toBe('failed');
    expect(executor.calls).toHaveLength(2);
  });
});

describe('agent events and run context', () => {
  it('should emit an ordered lifecycle event trail', async () => {
    const types: string[] = [];
    const executor = mockExecutor(() => ({ success: true }));
    const runner = new AgentRunner({
      observe: () => Promise.resolve(emptyObservation()),
      analyze: () => Promise.resolve(analysisWith([])),
      executorFactory: () => executor,
      onEvent: (event) => {
        types.push(event.type);
      },
    });
    const { context } = await runner.run({ workspaceRoot: '/tmp/ws' });
    expect(types).toEqual([
      'observation-started',
      'observation-completed',
      'analysis-completed',
      'resolved',
    ]);
    expect(context.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(context.events.every((e) => e.runId === context.id)).toBe(true);
  });

  it('should track the full run context without secrets', async () => {
    const executor = mockExecutor(() => ({ success: true }));
    const secretDiag = diagnostic({
      remediationCandidates: [
        {
          id: 'rem-1',
          type: 'create-environment',
          description: 'Create with secret',
          confidence: 1,
          riskLevel: 'project-modification',
          payload: { path: 's.txt', content: 'x', token: 'super-secret' },
        },
      ],
      requirement: undefined,
      code: MISSING_REQUIRED_FILE_CODE,
      category: 'project',
    });
    const runner = new AgentRunner({
      observe: () => Promise.resolve(emptyObservation()),
      analyze: (obs) =>
        Promise.resolve({
          observation: obs,
          diagnostics: [secretDiag],
          blockingDiagnostics: [secretDiag],
          timestamp: new Date(),
        }),
      executorFactory: () => executor,
    });
    const { context, result } = await runner.run({
      workspaceRoot: '/tmp/ws',
      dryRun: true,
    });
    expect(result.status).toBe('awaiting-approval');
    expect(context.plans).toHaveLength(1);
    expect(context.approvals).toHaveLength(0);
    expect(JSON.stringify(context)).not.toContain('super-secret');
  });
});
