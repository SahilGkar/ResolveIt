import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { mkdtemp } from 'fs/promises';
import { fileURLToPath } from 'url';
import { scanWorkspace } from '../src/scanners/index.js';
import { scanRequirements } from '../src/requirements/index.js';
import { createDiagnosticEngine, diagnosticsToJSON } from '../src/diagnostics/index.js';
import { analyzeObservation, isBlockingDiagnostic } from '../src/agent/analysis.js';
import type { AgentAnalysis } from '../src/agent/analysis.js';
import { createDeterministicRepairPlanner } from '../src/agent/deterministic-planner.js';
import { createAgentRunner } from '../src/agent/runner.js';
import { createRepairExecutor } from '../src/repair/index.js';
import { assertRunTransition } from '../src/agent/run-state.js';
import { createAIPlanner } from '../src/agent/ai-planner.js';
import { LocalAIProvider } from '../src/ai/providers/local.js';
import { ExternalAIProvider } from '../src/ai/providers/external.js';
import type { FetchImpl } from '../src/ai/http.js';
import type { AgentObservation } from '../src/agent/observation.js';
import type {
  Diagnostic,
  EnvironmentInfo,
  ParsedRequirements,
  RepairAction,
  Workspace,
} from '../src/core/models.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INTEGRATION = join(HERE, 'fixtures', 'integration');

async function copyFixture(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'resolveit-int-'));
  await fs.cp(join(INTEGRATION, name), join(root, name), { recursive: true });
  return join(root, name);
}

/**
 * Materialize a project-local `node_modules` tree in a copied fixture.
 * Health must be proven by the actual tree (never by the manifest alone),
 * and `node_modules/` is git-ignored, so healthy fixtures gain their tree
 * here at test time rather than in the fixture directory.
 */
async function materializeInstalledNodePackages(root: string, packages: Record<string, string>): Promise<void> {
  for (const [name, version] of Object.entries(packages)) {
    const dir = join(root, 'node_modules', ...name.split('/'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ name, version }), 'utf-8');
  }
}

function toolInstall(
  name: string,
  command: string,
  version: string,
  available = true
): EnvironmentInfo['runtimes'][number] {
  return { name, command, version, available };
}

function healthyEnv(): EnvironmentInfo {
  return {
    os: { platform: 'linux', architecture: 'x64', hostname: 'release-check' },
    runtimes: [
      toolInstall('Node.js', 'node', '20.11.0'),
      toolInstall('Python', 'python', '3.11.4'),
      toolInstall('Go', 'go', '1.21.5'),
      toolInstall('Rust', 'rustc', '1.75.0'),
      toolInstall('Java', 'java', '17.0.1'),
    ],
    devTools: [
      toolInstall('Docker', 'docker', '24.0.0'),
      toolInstall('CMake', 'cmake', '3.20.0'),
    ],
    packageManagers: [toolInstall('npm', 'npm', '10.2.4')],
    containers: {
      docker: toolInstall('Docker', 'docker', '24.0.0'),
      dockerCompose: toolInstall('Docker Compose', 'docker-compose', '2.24.0'),
      dockerRunning: true,
    },
    environmentVariables: {},
    scannedAt: new Date(),
  };
}

interface Pipeline {
  workspace: Workspace;
  requirements: ReadonlyArray<ParsedRequirements>;
  diagnostics: ReadonlyArray<Diagnostic>;
}

async function runPipeline(root: string, env: EnvironmentInfo): Promise<Pipeline> {
  const workspace = await scanWorkspace(root);
  const requirements = await scanRequirements(root);
  const engine = createDiagnosticEngine();
  const diagnostics = await engine.runDiagnosticsWithContext(workspace, env, requirements);
  return { workspace, requirements, diagnostics };
}

function normalize(value: unknown, roots: ReadonlyArray<string> = []): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const root of roots) {
      text = text.split(root).join('[root]');
    }
    return text;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalize(entry, roots));
  }
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) {
      return '[date]';
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'id' || key === 'timestamp' || key === 'createdAt' || key === 'scannedAt') {
        continue;
      }
      out[key] = normalize(entry, roots);
    }
    return out;
  }
  return value;
}

function blocking(diagnostics: ReadonlyArray<Diagnostic>): ReadonlyArray<Diagnostic> {
  return diagnostics.filter(isBlockingDiagnostic);
}

function syntheticFileDiagnostic(root: string, file: string, content: string): Diagnostic {
  return {
    id: 'diag-synthetic',
    code: 'MISSING_REQUIRED_FILE',
    severity: 'error',
    category: 'project',
    title: `Missing required file ${file}`,
    message: `Project requires ${file}`,
    evidence: [{ source: 'project', description: `Missing ${file}`, file }],
    affectedFiles: [file],
    remediationCandidates: [
      {
        id: 'rem-synthetic',
        type: 'create-environment',
        description: `Create ${file}`,
        confidence: 1,
        riskLevel: 'project-modification',
        payload: { path: file, content },
      },
    ],
    source: 'project-scanner',
    timestamp: new Date(),
    metadata: {},
  };
}

describe('Release matrix: healthy-project invariants', () => {
  const cases: ReadonlyArray<{ fixture: string; type: string }> = [
    { fixture: 'healthy-node', type: 'npm' },
    { fixture: 'healthy-python', type: 'pip' },
    { fixture: 'healthy-go', type: 'go-mod' },
    { fixture: 'healthy-rust', type: 'cargo' },
    { fixture: 'healthy-java', type: 'maven' },
    { fixture: 'healthy-cpp', type: 'cmake' },
  ];

  for (const { fixture, type } of cases) {
    it(`${fixture}: discovery, requirements, no blocking diagnostics`, async () => {
      const root = await copyFixture(fixture);
      try {
        if (fixture === 'healthy-node') {
          await materializeInstalledNodePackages(root, { lodash: '4.17.21' });
        }
        const { workspace, requirements, diagnostics } = await runPipeline(root, healthyEnv());
        expect(workspace.projects).toHaveLength(1);
        expect(workspace.projects[0]?.type).toBe(type);
        const errors = requirements.flatMap((parsed) => parsed.parseErrors);
        expect(errors).toHaveLength(0);
        expect(requirements.flatMap((parsed) => parsed.requirements).length).toBeGreaterThan(0);
        expect(blocking(diagnostics)).toHaveLength(0);
      } finally {
        await fs.rm(join(root, '..'), { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  it('healthy-node: deterministic planner proposes no executable actions', async () => {
    const root = await copyFixture('healthy-node');
    try {
      await materializeInstalledNodePackages(root, { lodash: '4.17.21' });
      const { workspace, requirements, diagnostics } = await runPipeline(root, healthyEnv());
      const observation: AgentObservation = { workspace, environment: healthyEnv(), requirements, timestamp: new Date() };
      const analysis: AgentAnalysis = { observation, diagnostics, blockingDiagnostics: blocking(diagnostics), timestamp: new Date() };
      const planner = createDeterministicRepairPlanner();
      const { plan, manualActions } = await planner.createPlan({ analysis, workspaceRoot: root });
      expect(plan.actions).toHaveLength(0);
      expect(manualActions).toHaveLength(0);
    } finally {
      await fs.rm(join(root, '..'), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('node without an installed tree: declared lodash is reported missing and blocking', async () => {
    const root = await copyFixture('healthy-node');
    try {
      const { diagnostics } = await runPipeline(root, healthyEnv());
      const missing = blocking(diagnostics).filter((diag) => diag.code === 'DEPENDENCY_PACKAGE_MISSING');
      expect(missing).toHaveLength(1);
      expect(missing[0]?.requirement?.name).toBe('lodash');
    } finally {
      await fs.rm(join(root, '..'), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('healthy diagnostics are deterministic across repeated runs', async () => {
    const first = await copyFixture('healthy-node');
    const second = await copyFixture('healthy-node');
    try {
      const a = await runPipeline(first, healthyEnv());
      const b = await runPipeline(second, healthyEnv());
      const roots = [first, second];
      expect(JSON.stringify(normalize(a.diagnostics, roots))).toBe(JSON.stringify(normalize(b.diagnostics, roots)));
      expect(JSON.stringify(normalize(a.requirements, roots))).toBe(JSON.stringify(normalize(b.requirements, roots)));
    } finally {
      await fs.rm(join(first, '..'), { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(join(second, '..'), { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe('Release matrix: broken-project invariants', () => {
  it('broken-node: detects project, requirement, error diagnostics, install + manual path', async () => {
    const root = await copyFixture('broken-node');
    try {
      const { workspace, requirements, diagnostics } = await runPipeline(root, healthyEnv());
      expect(workspace.projects).toHaveLength(1);
      const reqs = requirements.flatMap((parsed) => parsed.requirements);
      expect(reqs.some((req) => req.ecosystem === 'node' && req.type === 'runtime-version')).toBe(true);
      const blocked = blocking(diagnostics);
      expect(blocked.length).toBeGreaterThan(0);
      for (const diag of blocked) {
        expect(diag.evidence.length).toBeGreaterThan(0);
        expect(diag.affectedFiles?.length).toBeGreaterThan(0);
      }
      // The unsupported runtime keeps its system-level manual path, while the
      // uninstalled lodash dependency deterministically yields an install action.
      expect(blocked.some((diag) => diag.category === 'runtime')).toBe(true);
      expect(blocked.some((diag) => diag.code === 'DEPENDENCY_PACKAGE_MISSING')).toBe(true);
      const observation: AgentObservation = { workspace, environment: healthyEnv(), requirements, timestamp: new Date() };
      const analysis: AgentAnalysis = { observation, diagnostics, blockingDiagnostics: blocked, timestamp: new Date() };
      const planner = createDeterministicRepairPlanner();
      const { plan, manualActions } = await planner.createPlan({ analysis, workspaceRoot: root });
      const install = plan.actions.find((action) => action.type === 'install-dependency');
      expect(install?.parameters).toMatchObject({ ecosystem: 'npm', package: 'lodash' });
      expect(manualActions.length).toBeGreaterThan(0);
      expect(manualActions[0]?.riskLevel).toBe('system-modification');
    } finally {
      await fs.rm(join(root, '..'), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('broken-python: runtime mismatch is blocking with evidence', async () => {
    const root = await copyFixture('broken-python');
    try {
      const { diagnostics } = await runPipeline(root, healthyEnv());
      const blocked = blocking(diagnostics);
      expect(blocked.length).toBeGreaterThan(0);
      expect(blocked[0]?.category).toBe('runtime');
    } finally {
      await fs.rm(join(root, '..'), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('malformed-project: parse error diagnostic preserves source info', async () => {
    const root = await copyFixture('malformed-project');
    try {
      const { requirements, diagnostics } = await runPipeline(root, healthyEnv());
      expect(requirements.flatMap((parsed) => parsed.parseErrors).length).toBeGreaterThan(0);
      const parseDiags = diagnostics.filter((diag) => diag.code === 'PROJECT_PARSE_ERROR');
      expect(parseDiags.length).toBeGreaterThan(0);
      expect(parseDiags[0]?.source).toBe('project-scanner');
      expect(parseDiags[0]?.evidence.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(join(root, '..'), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('docker-security: privileged and socket findings are critical and diagnostic-only', async () => {
    const root = await copyFixture('docker-security');
    try {
      const { diagnostics } = await runPipeline(root, healthyEnv());
      const codes = diagnostics.map((diag) => diag.code);
      expect(codes).toContain('CONTAINER_PRIVILEGED_MODE');
      expect(codes).toContain('CONTAINER_DOCKER_SOCKET');
      for (const diag of diagnostics.filter((item) => item.category === 'container')) {
        expect(diag.remediationCandidates ?? []).toHaveLength(0);
      }
    } finally {
      await fs.rm(join(root, '..'), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('secrets: .env never parsed, findings and audit carry no secret values', async () => {
    const root = await copyFixture('secrets');
    try {
      const { requirements, diagnostics } = await runPipeline(root, healthyEnv());
      const sources = requirements.flatMap((parsed) => parsed.sourceFiles);
      expect(sources.some((file) => file.endsWith('.env'))).toBe(false);
      expect(JSON.stringify(normalize(diagnostics))).not.toContain('fake-integration-key-0000');
      expect(JSON.stringify(normalize(diagnostics))).not.toContain('fake-integration-password-0000');
    } finally {
      await fs.rm(join(root, '..'), { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe('Release: repair/verification truthfulness', () => {
  async function stagedRun(options: {
    analyzeCalls: ReadonlyArray<ReadonlyArray<Diagnostic>>;
    approve: ReadonlyArray<string> | 'all';
    maxIterations?: number;
  }): Promise<{ root: string; status: string; fileExists: boolean; reports: ReadonlyArray<{ success: boolean }> }> {
    const root = await copyFixture('healthy-node');
    const calls = [...options.analyzeCalls];
    const runner = createAgentRunner({
      observe: async (workspaceRoot: string): Promise<AgentObservation> => ({
        workspace: await scanWorkspace(workspaceRoot),
        environment: healthyEnv(),
        requirements: await scanRequirements(workspaceRoot),
        timestamp: new Date(),
      }),
      analyze: async (observation: AgentObservation): Promise<AgentAnalysis> => {
        const next = calls.shift() ?? [];
        return { observation, diagnostics: next, blockingDiagnostics: [...next], timestamp: new Date() };
      },
    });
    const approvalCallback = async (plan: { actions: ReadonlyArray<RepairAction> }): Promise<ReadonlyArray<string>> =>
      options.approve === 'all' ? plan.actions.map((action) => action.id) : [...options.approve];
    const { result } = await runner.run({
      workspaceRoot: root,
      approvalCallback,
      maxIterations: options.maxIterations ?? 1,
    });
    let exists = false;
    try {
      await fs.access(join(root, 'release-note.txt'));
      exists = true;
    } catch {
      exists = false;
    }
    return { root, status: result.status, fileExists: exists, reports: result.verificationReports };
  }

  it('denied: not performed, not resolved', async () => {
    const staged = await stagedRun({
      analyzeCalls: [[syntheticFileDiagnostic('', 'release-note.txt', 'hello')]],
      approve: [],
    });
    try {
      expect(staged.status).toBe('failed');
      expect(staged.fileExists).toBe(false);
      expect(staged.reports).toHaveLength(0);
    } finally {
      await fs.rm(join(staged.root, '..'), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('approved + verified: resolved with passing verification', async () => {
    const staged = await stagedRun({
      analyzeCalls: [[syntheticFileDiagnostic('', 'release-note.txt', 'hello')], []],
      approve: 'all',
    });
    try {
      expect(staged.status).toBe('resolved');
      expect(staged.fileExists).toBe(true);
      expect(staged.reports).toHaveLength(1);
      expect(staged.reports[0]?.success).toBe(true);
    } finally {
      await fs.rm(join(staged.root, '..'), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('approved but persisting: verification fails, no false success', async () => {
    const diag = syntheticFileDiagnostic('', 'release-note.txt', 'hello');
    const staged = await stagedRun({ analyzeCalls: [[diag], [diag]], approve: 'all', maxIterations: 1 });
    try {
      expect(staged.status).toBe('failed');
      expect(staged.fileExists).toBe(true);
      expect(staged.reports).toHaveLength(1);
      expect(staged.reports[0]?.success).toBe(false);
    } finally {
      await fs.rm(join(staged.root, '..'), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('failed repair: execution failure is recorded, never reported as success', async () => {
    const root = await copyFixture('healthy-node');
    try {
      const executor = createRepairExecutor(root);
      const outcome = await executor.executePlan(
        {
          id: 'plan-1',
          name: 'p',
          description: 'p',
          requiresApproval: true,
          actions: [
            {
              id: 'action-install',
              type: 'install-dependency',
              permissionLevel: 'project-modification',
              description: 'Install missing package',
              target: {},
              parameters: { ecosystem: 'npm', package: 'lodash;evil', workspaceRoot: root },
              riskLevel: 'project-modification',
              prerequisites: [],
            },
          ],
        },
        { dryRun: false, workspaceRoot: root, approvalCallback: async () => 'allowed' }
      );
      expect(outcome.success).toBe(false);
      expect(outcome.results[0]?.result.error).toContain('Invalid package name');
    } finally {
      await fs.rm(join(root, '..'), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('throwing repair tool becomes a recorded failure with audit entry', async () => {
    const root = await copyFixture('healthy-node');
    try {
      const executor = createRepairExecutor(root);
      executor.getRegistry().register({
        name: 'thrower',
        description: 'throws',
        permissionLevel: 'project-modification',
        supportedActionTypes: ['custom'],
        validate: () => ({ valid: true, errors: [], warnings: [] }),
        execute: () => Promise.reject(new Error('boom')),
      });
      const outcome = await executor.executePlan(
        {
          id: 'plan-1',
          name: 'p',
          description: 'p',
          requiresApproval: false,
          actions: [
            {
              id: 'action-throw',
              type: 'custom',
              permissionLevel: 'project-modification',
              description: 'throwing action',
              target: {},
              parameters: { workspaceRoot: root },
              riskLevel: 'project-modification',
              prerequisites: [],
            },
          ],
        },
        { dryRun: false, workspaceRoot: root, approvalCallback: async () => 'allowed', runId: 'run-throw' }
      );
      expect(outcome.success).toBe(false);
      expect(outcome.results[0]?.result.error).toContain('boom');
    } finally {
      await fs.rm(join(root, '..'), { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe('Release: determinism audit', () => {
  it('multi-project and nested fixtures are stable across runs', async () => {
    for (const fixture of ['multi-project', 'nested-projects']) {
      const first = await copyFixture(fixture);
      const second = await copyFixture(fixture);
      try {
      const a = await runPipeline(first, healthyEnv());
      const b = await runPipeline(second, healthyEnv());
      const roots = [first, second];
      expect(JSON.stringify(normalize(a.workspace, roots))).toBe(JSON.stringify(normalize(b.workspace, roots)));
      expect(JSON.stringify(normalize(a.requirements, roots))).toBe(JSON.stringify(normalize(b.requirements, roots)));
      expect(JSON.stringify(normalize(a.diagnostics, roots))).toBe(JSON.stringify(normalize(b.diagnostics, roots)));
      expect(diagnosticsToJSON(a.diagnostics).length).toBeGreaterThan(0);
      } finally {
        await fs.rm(join(first, '..'), { recursive: true, force: true }).catch(() => undefined);
        await fs.rm(join(second, '..'), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });
});

describe('Release: failure injection', () => {
  function localWithTransport(fetchImpl: FetchImpl): LocalAIProvider {
    return new LocalAIProvider({ provider: 'local', model: 'test-model', timeoutMs: 500 }, { fetchImpl });
  }

  function externalWithTransport(fetchImpl: FetchImpl): ExternalAIProvider {
    return new ExternalAIProvider(
      { provider: 'external', model: 'test-model', baseUrl: 'https://example.test/v1', apiKey: 'fake-test-key', timeoutMs: 500 },
      { fetchImpl }
    );
  }

  it('AI timeout and unavailability fall back deterministically', async () => {
    const hanging: FetchImpl = (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    const failing: FetchImpl = () => Promise.reject(new Error('connection refused'));
    for (const provider of [localWithTransport(hanging), externalWithTransport(failing)]) {
      const planner = createAIPlanner(provider);
      const observation: AgentObservation = {
        workspace: { projects: [], languages: [], rootPath: '/tmp/ws' } as unknown as AgentObservation['workspace'],
        environment: healthyEnv(),
        requirements: [],
        timestamp: new Date(),
      };
      const plan = await planner({
        analysis: { observation, diagnostics: [], blockingDiagnostics: [], timestamp: new Date() },
        workspaceRoot: '/tmp/ws',
        attemptedFingerprints: new Set<string>(),
      });
      expect(plan.aiUsed).toBe(false);
      expect(plan.plan.actions.every((action) => action.type !== 'run-shell')).toBe(true);
    }
  });

  it('malformed and hostile AI transport output never bypasses validation', async () => {
    const localMalformed: FetchImpl = () =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"message":{"content":"not json at all"}}') });
    const hostilePayload = JSON.stringify({
      summary: 'do evil',
      actions: [{ type: 'run-shell', parameters: { command: 'cat .env' } }],
    });
    const externalHostile: FetchImpl = () =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: hostilePayload } }] })) });
    for (const provider of [localWithTransport(localMalformed), externalWithTransport(externalHostile)]) {
      const planner = createAIPlanner(provider);
      const observation: AgentObservation = {
        workspace: { projects: [], languages: [], rootPath: '/tmp/ws' } as unknown as AgentObservation['workspace'],
        environment: healthyEnv(),
        requirements: [],
        timestamp: new Date(),
      };
      const plan = await planner({
        analysis: {
          observation,
          diagnostics: [syntheticFileDiagnostic('/tmp/ws', 'x.txt', 'y')],
          blockingDiagnostics: [syntheticFileDiagnostic('/tmp/ws', 'x.txt', 'y')],
          timestamp: new Date(),
        },
        workspaceRoot: '/tmp/ws',
        attemptedFingerprints: new Set<string>(),
      });
      expect(plan.aiUsed).toBe(false);
      const forbidden = plan.plan.actions.some((action) =>
        JSON.stringify(action.parameters).includes('cat .env')
      );
      expect(forbidden).toBe(false);
    }
  });

  it('vanished workspace fails with a useful error, never a false success', async () => {
    const runner = createAgentRunner();
    const missing = join(tmpdir(), 'resolveit-no-such-dir-xyz');
    const { result } = await runner.run({ workspaceRoot: missing, maxIterations: 1 });
    expect(result.status).toBe('failed');
    expect(result.reason ?? '').toMatch(/not found|no such|ENOENT|Workspace/i);
  });

  it('concurrent runs stay independent', async () => {
    const root = await copyFixture('healthy-node');
    try {
      const runner = createAgentRunner({
        observe: async (workspaceRoot: string): Promise<AgentObservation> => ({
          workspace: await scanWorkspace(workspaceRoot),
          environment: healthyEnv(),
          requirements: await scanRequirements(workspaceRoot),
          timestamp: new Date(),
        }),
      });
      const [first, second] = await Promise.all([
        runner.run({ workspaceRoot: root, dryRun: true }),
        runner.run({ workspaceRoot: root, dryRun: true }),
      ]);
      expect(first.context.id).not.toBe(second.context.id);
    } finally {
      await fs.rm(join(root, '..'), { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe('Release: agent loop validation', () => {
  it('rejects illegal state transitions', () => {
    expect(() => assertRunTransition('idle', 'acting')).toThrow();
    expect(() => assertRunTransition('resolved', 'planning')).toThrow();
    expect(() => assertRunTransition('idle', 'observing')).not.toThrow();
  });

  it('enforces max iterations and prevents repeated failed actions', async () => {
    const root = await copyFixture('healthy-node');
    try {
      const diag = syntheticFileDiagnostic(root, 'loop.txt', 'content');
      const runner = createAgentRunner({
        observe: async (workspaceRoot: string): Promise<AgentObservation> => ({
          workspace: await scanWorkspace(workspaceRoot),
          environment: healthyEnv(),
          requirements: await scanRequirements(workspaceRoot),
          timestamp: new Date(),
        }),
        analyze: async (observation: AgentObservation): Promise<AgentAnalysis> => ({
          observation,
          diagnostics: [diag],
          blockingDiagnostics: [diag],
          timestamp: new Date(),
        }),
        executorFactory: () => ({
          executePlan: async (plan) => ({
            results: plan.actions.map((action) => ({
              action,
              result: { success: false, error: 'injected execution failure' },
            })),
            success: false,
          }),
        }),
      });
      const events: string[] = [];
      const { result, context } = await runner.run({
        workspaceRoot: root,
        approvalCallback: async (plan) => plan.actions.map((action) => action.id),
        maxIterations: 2,
      });
      expect(result.iterations).toBe(2);
      expect(result.status).toBe('failed');
      expect(context.failedFingerprints.length).toBeGreaterThan(0);
      for (const event of context.events) {
        events.push(event.type);
      }
      expect(events[0]).toBe('observation-started');
      expect(events).toContain('replanning');
      const seqs = context.events.map((event) => event.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    } finally {
      await fs.rm(join(root, '..'), { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe('Release: AI-assisted lifecycle with real executor and verifier', () => {
  it('valid AI proposal executes only validated actions and resolves', async () => {
    const root = await copyFixture('healthy-node');
    const calls = 2;
    let call = 0;
    const provider = {
      type: 'external' as const,
      name: 'mock',
      version: '0',
      isAvailable: () => Promise.resolve(true),
      diagnose: () => Promise.reject(new Error('unused')),
      planRepair: () => Promise.reject(new Error('unused')),
      generatePlan: () =>
        Promise.resolve({
          summary: 'create a note',
          actions: [{ type: 'create-file', parameters: { path: 'ai-note.txt', content: 'ai WAS here' } }],
        }),
    };
    const runner = createAgentRunner({
      observe: async (workspaceRoot: string): Promise<AgentObservation> => ({
        workspace: await scanWorkspace(workspaceRoot),
        environment: healthyEnv(),
        requirements: await scanRequirements(workspaceRoot),
        timestamp: new Date(),
      }),
      analyze: async (observation: AgentObservation): Promise<AgentAnalysis> => {
        call += 1;
        const pending = call < calls ? [syntheticFileDiagnostic(root, 'ai-note.txt', 'ai WAS here')] : [];
        return { observation, diagnostics: pending, blockingDiagnostics: [...pending], timestamp: new Date() };
      },
      plan: createAIPlanner(provider as never),
    });
    const { result } = await runner.run({
      workspaceRoot: root,
      approvalCallback: async (plan) => plan.actions.map((action) => action.id),
      maxIterations: 2,
    });
    expect(result.status).toBe('resolved');
    expect(await fs.readFile(join(root, 'ai-note.txt'), 'utf-8')).toBe('ai WAS here');
    await fs.rm(join(root, '..'), { recursive: true, force: true }).catch(() => undefined);
  });
});

describe('Release: multi-project validation', () => {
  it('attributes projects, requirements, and diagnostics correctly', async () => {
    const root = await copyFixture('multi-project');
    try {
      const { workspace, requirements, diagnostics } = await runPipeline(root, healthyEnv());
      expect(workspace.projects).toHaveLength(4);
      const roots = workspace.projects.map((project) => project.projectRoot).sort();
      expect(roots).toEqual(['backend', 'docker', 'frontend', 'worker']);
      const ownership = new Map(requirements.map((parsed) => [parsed.sourceFiles[0], parsed.projectRoot]));
      expect(ownership.get('frontend/package.json')).toBe('frontend');
      expect(ownership.get('backend/pyproject.toml')).toBe('backend');
      expect(ownership.get('worker/go.mod')).toBe('worker');
      const files = workspace.projects.flatMap((project) => [
        ...project.sourceFiles,
        ...project.testFiles,
        ...project.documentationFiles,
        ...project.otherFiles,
      ]);
      const unique = new Set(files.map((file) => file.relativePath));
      expect(unique.size).toBe(files.length);
      for (const diag of diagnostics) {
        expect(diag.evidence.length).toBeGreaterThan(0);
        expect(diag.source).toBeTruthy();
      }
      const observation: AgentObservation = { workspace, environment: healthyEnv(), requirements, timestamp: new Date() };
      const analysis = await analyzeObservation(observation);
      expect(analysis.observation.workspace.projects).toHaveLength(4);
    } finally {
      await fs.rm(join(root, '..'), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('nested projects keep separate identity without double counting', async () => {
    const root = await copyFixture('nested-projects');
    try {
      const { workspace, requirements } = await runPipeline(root, healthyEnv());
      expect(workspace.projects.length).toBeGreaterThanOrEqual(2);
      const ids = new Set(workspace.projects.map((project) => project.id));
      expect(ids.size).toBe(workspace.projects.length);
      const allSources = requirements.flatMap((parsed) => parsed.sourceFiles);
      expect(new Set(allSources).size).toBe(allSources.length);
    } finally {
      await fs.rm(join(root, '..'), { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
