import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import { AgentRunner } from '../src/agent/runner.js';
import type { PlanExecutor } from '../src/agent/runner.js';
import { analyzeObservation } from '../src/agent/analysis.js';
import type { AgentAnalysis } from '../src/agent/index.js';
import { MISSING_REQUIRED_FILE_CODE } from '../src/agent/index.js';
import type { Diagnostic, ProjectRequirement, RepairPlan } from '../src/core/models.js';

const testWorkspace = join(tmpdir(), 'resolveit-agent-e2e-');

function mockFailingExecutor(): PlanExecutor & { calls: RepairPlan[] } {
  const calls: RepairPlan[] = [];
  return {
    calls,
    executePlan: (plan) => {
      calls.push(plan);
      return Promise.resolve({
        results: plan.actions.map((action) => ({
          action,
          result: { success: false, error: 'mocked execution failure' },
        })),
        success: false,
      });
    },
  };
}

function packageDependencyDiagnostic(name: string, id: string): Diagnostic {
  const requirement: ProjectRequirement = {
    id: `req-${id}`,
    ecosystem: 'node',
    type: 'package-dependency',
    name,
    versionConstraint: '^1.0.0',
    sourceFile: 'package.json',
  };
  return {
    id,
    code: 'DEPENDENCY_PACKAGE-DEPENDENCY_MISMATCH',
    severity: 'error',
    category: 'dependency',
    title: `Dependency: ${name}`,
    message: `${name} is missing`,
    evidence: [],
    affectedFiles: ['package.json'],
    requirement,
    source: 'dependency-resolver',
    timestamp: new Date(),
    metadata: {},
  };
}

describe('agent end-to-end', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(testWorkspace);
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('1. should resolve an already-healthy project without acting', async () => {
    const runner = new AgentRunner();
    const { context, result } = await runner.run({ workspaceRoot });
    expect(result.status).toBe('resolved');
    expect(result.iterations).toBe(0);
    expect(context.state).toBe('resolved');
    expect(context.executedActions).toHaveLength(0);
    expect(context.verificationReports).toHaveLength(0);
  }, 120000);

  it('2. should create a missing file, verify, and resolve', async () => {
    const analyzeWithRequiredFile = async (workspace: Parameters<typeof analyzeObservation>[0]): Promise<AgentAnalysis> => {
      const analysis = await analyzeObservation(workspace);
      const marker = join(workspaceRoot, 'hello.txt');
      const exists = await fs.access(marker).then(() => true).catch(() => false);
      if (exists) {
        return analysis;
      }
      const synthetic: Diagnostic = {
        id: 'diag-missing-file',
        code: MISSING_REQUIRED_FILE_CODE,
        severity: 'error',
        category: 'project',
        title: 'Required file hello.txt is missing',
        message: 'Project requires hello.txt but it does not exist',
        evidence: [{ source: 'project', description: 'hello.txt not found', file: 'hello.txt' }],
        affectedFiles: ['hello.txt'],
        source: 'project-scanner',
        timestamp: new Date(),
        metadata: {},
        remediationCandidates: [
          {
            id: 'rem-file',
            type: 'create-environment',
            description: 'Create required file hello.txt',
            confidence: 1,
            riskLevel: 'project-modification',
            payload: { path: 'hello.txt', content: 'hello from agent' },
          },
        ],
      };
      return {
        ...analysis,
        diagnostics: [...analysis.diagnostics, synthetic],
        blockingDiagnostics: [...analysis.blockingDiagnostics, synthetic],
      };
    };

    const runner = new AgentRunner({ analyze: analyzeWithRequiredFile });
    const { context, result } = await runner.run({
      workspaceRoot,
      approvalCallback: (plan) => Promise.resolve(plan.actions.map((action) => action.id)),
    });

    expect(result.status).toBe('resolved');
    expect(result.iterations).toBe(1);
    expect(context.executedActions).toHaveLength(1);
    expect(context.executedActions[0]?.result.success).toBe(true);
    const content = await fs.readFile(join(workspaceRoot, 'hello.txt'), 'utf-8');
    expect(content).toBe('hello from agent');
    expect(context.verificationReports).toHaveLength(1);
    expect(context.verificationReports[0]?.success).toBe(true);
    expect(context.state).toBe('resolved');
  }, 120000);

  it('3. should require manual action for unsupported system runtimes', async () => {
    await fs.writeFile(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', engines: { node: '>=99.0.0' } }),
      'utf-8'
    );
    const runner = new AgentRunner();
    const { context, result } = await runner.run({
      workspaceRoot,
      approvalCallback: (plan) => Promise.resolve(plan.actions.map((action) => action.id)),
    });

    expect(result.status).toBe('manual-action-required');
    expect(context.state).toBe('failed');
    expect(result.manualActions.length).toBeGreaterThan(0);
    expect(context.executedActions).toHaveLength(0);
    const entries = await fs.readdir(workspaceRoot);
    expect(entries).toEqual(['package.json']);
  }, 120000);

  it('4. should re-plan with new evidence after a failed repair', async () => {
    let analyses = 0;
    const executor = mockFailingExecutor();
    const runner = new AgentRunner({
      observe: () =>
        Promise.resolve({
          workspace: {
            id: 'ws-1',
            rootPath: workspaceRoot,
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
        }),
      analyze: (obs) => {
        analyses += 1;
        const diag = packageDependencyDiagnostic(`pkg-${analyses}`, `diag-${analyses}`);
        return Promise.resolve({
          observation: obs,
          diagnostics: [diag],
          blockingDiagnostics: [diag],
          timestamp: new Date(),
        });
      },
      executorFactory: () => executor,
      verifier: {
        verifyPlan: () =>
          Promise.resolve({
            success: false,
            diagnostics: [],
            resolvedDiagnostics: [],
            remainingDiagnostics: ['dependency|still-there'],
            evidence: [],
            summary: 'repair did not resolve the diagnostic',
          }),
      },
    });

    const { context, result } = await runner.run({
      workspaceRoot,
      maxIterations: 3,
      approvalCallback: (plan) => Promise.resolve(plan.actions.map((action) => action.id)),
    });

    expect(result.status).toBe('failed');
    expect(result.iterations).toBe(3);
    expect(executor.calls).toHaveLength(3);
    expect(analyses).toBe(4);
    expect(context.verificationReports).toHaveLength(3);
    const plannedPackages = context.plans.map(
      (entry) => (entry.plan.actions[0]?.parameters as Record<string, unknown>)?.['package']
    );
    expect(plannedPackages).toEqual(['pkg-1', 'pkg-2', 'pkg-3']);
  });

  it('5. should fail when the retry limit is reached on a persistent problem', async () => {
    const executor = mockFailingExecutor();
    const runner = new AgentRunner({
      observe: () =>
        Promise.resolve({
          workspace: {
            id: 'ws-1',
            rootPath: workspaceRoot,
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
        }),
      analyze: (obs) => {
        const diag = packageDependencyDiagnostic('stubborn-pkg', 'diag-1');
        return Promise.resolve({
          observation: obs,
          diagnostics: [diag],
          blockingDiagnostics: [diag],
          timestamp: new Date(),
        });
      },
      executorFactory: () => executor,
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

    const { context, result } = await runner.run({
      workspaceRoot,
      maxIterations: 1,
      approvalCallback: (plan) => Promise.resolve(plan.actions.map((action) => action.id)),
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('1 iteration(s)');
    expect(result.iterations).toBe(1);
    expect(executor.calls).toHaveLength(1);
    expect(context.state).toBe('failed');
    expect(context.failedFingerprints.length).toBeGreaterThan(0);
  });
});
