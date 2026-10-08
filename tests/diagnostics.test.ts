import { describe, it, expect } from 'vitest';
import { createDiagnosticEngine, versionMatcher } from '../src/diagnostics/index.js';
import type {
  DiagnosticContext,
  EnvironmentInfo,
  ParsedRequirements,
  ProjectRequirement,
  Workspace,
} from '../src/core/interfaces.js';

function requirement(overrides: Partial<ProjectRequirement>): ProjectRequirement {
  return {
    id: 'req-1',
    ecosystem: 'node',
    type: 'runtime-version',
    name: 'node',
    versionConstraint: '>=18.0.0',
    sourceFile: 'package.json',
    ...overrides,
  };
}

function parsedRequirements(requirements: ProjectRequirement[], parseErrors: ParsedRequirements['parseErrors'] = []): ParsedRequirements {
  return {
    projectId: 'project-1',
    sourceFiles: ['package.json'],
    requirements,
    parseErrors,
  };
}

function environment(overrides: Partial<EnvironmentInfo> = {}): EnvironmentInfo {
  return {
    os: {
      platform: 'linux',
      architecture: 'x64',
      hostname: 'test-host',
    },
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
    ...overrides,
  };
}

function workspace(): Workspace {
  return {
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
  };
}

function context(env: EnvironmentInfo, reqs: ParsedRequirements[]): DiagnosticContext {
  return { workspace: workspace(), environment: env, requirements: reqs, versionMatcher };
}

describe('diagnostic engine regression', () => {
  describe('runtime diagnostics', () => {
    it('should report a runtime version mismatch', async () => {
      const engine = createDiagnosticEngine();
      const diags = await engine.runDiagnosticsWithContext(
        workspace(),
        environment({
          runtimes: [{ name: 'node', command: 'node', version: '16.0.0', available: true }],
        }),
        [parsedRequirements([requirement({ name: 'node', versionConstraint: '>=18.0.0' })])]
      );
      expect(diags).toHaveLength(1);
      expect(diags[0]?.category).toBe('runtime');
      expect(diags[0]?.severity).toBe('error');
      expect(diags[0]?.message).toContain('16.0.0');
    });

    it('should report a missing runtime', async () => {
      const engine = createDiagnosticEngine();
      const diags = await engine.runDiagnosticsWithContext(
        workspace(),
        environment({ runtimes: [] }),
        [parsedRequirements([requirement({ name: 'python', versionConstraint: '>=3.11' })])]
      );
      expect(diags).toHaveLength(1);
      expect(diags[0]?.severity).toBe('error');
      expect(diags[0]?.message).toContain('not installed');
    });

    it('should stay silent when the runtime satisfies the constraint', async () => {
      const engine = createDiagnosticEngine();
      const diags = await engine.runDiagnosticsWithContext(
        workspace(),
        environment({
          runtimes: [{ name: 'node', command: 'node', version: '20.5.0', available: true }],
        }),
        [parsedRequirements([requirement({ name: 'node', versionConstraint: '>=18.0.0' })])]
      );
      expect(diags).toHaveLength(0);
    });

    it('should warn when the installed version is unknown', async () => {
      const engine = createDiagnosticEngine();
      const diags = await engine.runDiagnosticsWithContext(
        workspace(),
        environment({
          runtimes: [{ name: 'node', command: 'node', version: 'unknown', available: true }],
        }),
        [parsedRequirements([requirement({ name: 'node', versionConstraint: '>=18.0.0' })])]
      );
      expect(diags).toHaveLength(1);
      expect(diags[0]?.severity).toBe('warning');
      expect(diags[0]?.message).toContain('Cannot verify');
    });
  });

  describe('toolchain diagnostics', () => {
    it('should report a tool version mismatch', async () => {
      const engine = createDiagnosticEngine();
      const diags = await engine.runDiagnosticsWithContext(
        workspace(),
        environment({
          devTools: [{ name: 'typescript', command: 'tsc', version: '4.9.0', available: true }],
        }),
        [
          parsedRequirements([
            requirement({ type: 'toolchain', name: 'typescript', versionConstraint: '^5.0.0', sourceFile: 'package.json' }),
          ]),
        ]
      );
      expect(diags).toHaveLength(1);
      expect(diags[0]?.category).toBe('toolchain');
      expect(diags[0]?.severity).toBe('error');
    });

    it('should report a missing tool', async () => {
      const engine = createDiagnosticEngine();
      const diags = await engine.runDiagnosticsWithContext(
        workspace(),
        environment({ devTools: [], packageManagers: [] }),
        [
          parsedRequirements([
            requirement({ type: 'system-tool', name: 'eslint', sourceFile: 'package.json' }),
          ]),
        ]
      );
      expect(diags).toHaveLength(1);
      expect(diags[0]?.message).toContain('not available');
    });
  });

  describe('container diagnostics', () => {
    const imageReq = requirement({
      type: 'container-image',
      name: 'postgres',
      versionConstraint: '15',
      sourceFile: 'docker-compose.yml',
    });

    it('should report missing docker when a container image is required', async () => {
      const engine = createDiagnosticEngine();
      const diags = await engine.runDiagnosticsWithContext(
        workspace(),
        environment(),
        [parsedRequirements([imageReq])]
      );
      expect(diags).toHaveLength(1);
      expect(diags[0]?.category).toBe('container');
      expect(diags[0]?.severity).toBe('error');
      expect(diags[0]?.message).toContain('not installed');
    });

    it('should warn when docker is installed but the daemon is stopped', async () => {
      const engine = createDiagnosticEngine();
      const env = environment({
        devTools: [{ name: 'docker', command: 'docker', version: '24.0.0', available: true }],
      });
      const diags = await engine.runDiagnosticsWithContext(workspace(), env, [parsedRequirements([imageReq])]);
      expect(diags).toHaveLength(1);
      expect(diags[0]?.severity).toBe('warning');
      expect(diags[0]?.message).toContain('not running');
    });

    it('should stay silent when docker is running', async () => {
      const engine = createDiagnosticEngine();
      const env = environment({
        devTools: [{ name: 'docker', command: 'docker', version: '24.0.0', available: true }],
        containers: {
          docker: { name: 'docker', command: 'docker', available: true },
          dockerCompose: { name: 'docker-compose', command: 'docker-compose', available: false },
          dockerRunning: true,
        },
      });
      const diags = await engine.runDiagnosticsWithContext(workspace(), env, [parsedRequirements([imageReq])]);
      expect(diags).toHaveLength(0);
    });
  });

  describe('dependency diagnostics', () => {
    it('should report a missing dependency when the local tree has no such package', async () => {
      const engine = createDiagnosticEngine();
      const diags = await engine.runDiagnosticsWithContext(
        workspace(),
        environment(),
        [
          parsedRequirements([
            requirement({
              type: 'package-dependency',
              name: 'lodash',
              versionConstraint: '^4.17.21',
              metadata: { scope: 'production' },
            }),
          ]),
        ]
      );
      expect(diags).toHaveLength(1);
      expect(diags[0]?.category).toBe('dependency');
      expect(diags[0]?.code).toBe('DEPENDENCY_PACKAGE_MISSING');
      expect(diags[0]?.severity).toBe('error');
      expect(diags[0]?.message).toContain('not currently installed');
    });
  });

  describe('version matching', () => {
    it('should match exact, range, caret, and tilde constraints', () => {
      expect(versionMatcher.matches('>=18.0.0', '20.5.0').satisfied).toBe(true);
      expect(versionMatcher.matches('>=18.0.0', '16.0.0').satisfied).toBe(false);
      expect(versionMatcher.matches('^1.2.3', '1.9.0').satisfied).toBe(true);
      expect(versionMatcher.matches('^1.2.3', '2.0.0').satisfied).toBe(false);
      expect(versionMatcher.matches('~1.2.3', '1.2.9').satisfied).toBe(true);
      expect(versionMatcher.matches('~1.2.3', '1.3.0').satisfied).toBe(false);
      expect(versionMatcher.matches('*', '9.9.9').satisfied).toBe(true);
    });

    it('should return unknown when the installed version is unavailable', () => {
      const result = versionMatcher.matches('>=18.0.0', 'unknown');
      expect(result.satisfied).toBe(false);
      expect(result.reason).toBe('unknown');
    });
  });

  describe('evidence, severity, and category', () => {
    it('should attach requirement and environment evidence', async () => {
      const engine = createDiagnosticEngine();
      const diags = await engine.runDiagnosticsWithContext(
        workspace(),
        environment(),
        [parsedRequirements([requirement({ name: 'python', versionConstraint: '>=3.11' })])]
      );
      const evidence = diags[0]?.evidence ?? [];
      expect(evidence.length).toBeGreaterThan(0);
      expect(evidence.map((e) => e.source)).toContain('requirement');
      expect(evidence.map((e) => e.source)).toContain('environment');
      expect(diags[0]?.requirement?.name).toBe('python');
      expect(diags[0]?.affectedFiles).toContain('package.json');
    });

    it('should expose remediation candidates', async () => {
      const engine = createDiagnosticEngine();
      const diags = await engine.runDiagnosticsWithContext(
        workspace(),
        environment(),
        [parsedRequirements([requirement({ name: 'python', versionConstraint: '>=3.11' })])]
      );
      expect(diags[0]?.remediationCandidates?.length).toBeGreaterThan(0);
    });

    it('should never offer install-dependency remediation for a runtime mismatch', async () => {
      const engine = createDiagnosticEngine();
      const diags = await engine.runDiagnosticsWithContext(
        workspace(),
        environment({
          runtimes: [{ name: 'node', command: 'node', version: '16.0.0', available: true }],
        }),
        [parsedRequirements([requirement({ name: 'node', versionConstraint: '>=99.0.0' })])]
      );
      expect(diags.length).toBeGreaterThan(0);
      for (const diag of diags.filter((entry) => entry.category === 'runtime')) {
        const installs = (diag.remediationCandidates ?? []).filter(
          (candidate) => candidate.type === 'install-dependency'
        );
        expect(installs).toEqual([]);
      }
    });
  });

  describe('deduplication and ordering', () => {
    it('should deduplicate identical diagnostics', async () => {
      const engine = createDiagnosticEngine();
      const duplicate = requirement({ type: 'package-dependency', name: 'lodash', versionConstraint: '^4.17.21' });
      const diags = await engine.runDiagnosticsWithContext(
        workspace(),
        environment(),
        [parsedRequirements([duplicate, { ...duplicate, id: 'req-2' }])]
      );
      expect(diags).toHaveLength(1);
    });

    it('should order diagnostics deterministically by severity, category, then title', async () => {
      const engine = createDiagnosticEngine();
      const diags = await engine.runDiagnosticsWithContext(
        workspace(),
        environment(),
        [
          parsedRequirements([
            requirement({ type: 'package-dependency', name: 'lodash', versionConstraint: '^4.17.21' }),
            requirement({ name: 'python', versionConstraint: '>=3.11' }),
          ]),
        ]
      );
      expect(diags.length).toBeGreaterThan(1);
      const severityRank = (s: string): number => ({ critical: 0, error: 1, warning: 2, info: 3, hint: 4 })[s] ?? 9;
      for (let i = 1; i < diags.length; i++) {
        expect(severityRank(diags[i]?.severity ?? '')).toBeGreaterThanOrEqual(
          severityRank(diags[i - 1]?.severity ?? '')
        );
      }
      const rerun = await engine.runDiagnosticsWithContext(
        workspace(),
        environment(),
        [
          parsedRequirements([
            requirement({ type: 'package-dependency', name: 'lodash', versionConstraint: '^4.17.21' }),
            requirement({ name: 'python', versionConstraint: '>=3.11' }),
          ]),
        ]
      );
      expect(rerun.map((d) => d.code)).toEqual(diags.map((d) => d.code));
    });
  });

  describe('project parse errors', () => {
    it('should surface requirement parse errors as project diagnostics', async () => {
      const engine = createDiagnosticEngine();
      const diags = await engine.runDiagnosticsWithContext(
        workspace(),
        environment(),
        [
          parsedRequirements([], [
            { sourceFile: 'package.json', error: 'Unexpected token', code: 'E_PARSE', severity: 'error' },
          ]),
        ]
      );
      expect(diags).toHaveLength(1);
      expect(diags[0]?.category).toBe('project');
      expect(diags[0]?.code).toBe('PROJECT_PARSE_ERROR');
    });
  });
});
