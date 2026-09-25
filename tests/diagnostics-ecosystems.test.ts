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
    type: 'package-dependency',
    name: 'lodash',
    versionConstraint: '^4.17.21',
    sourceFile: 'package.json',
    ...overrides,
  };
}

function parsedRequirements(requirements: ProjectRequirement[]): ParsedRequirements {
  return { projectId: 'root', projectRoot: '.', sourceFiles: ['package.json'], requirements, parseErrors: [] };
}

function environment(overrides: Partial<EnvironmentInfo> = {}): EnvironmentInfo {
  return {
    os: { platform: 'linux', architecture: 'x64', hostname: 'test-host' },
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

describe('ecosystem diagnostics proof', () => {
  it('should flag a python runtime mismatch from requires-python', async () => {
    const engine = createDiagnosticEngine();
    const diags = await engine.runDiagnosticsWithContext(
      workspace(),
      environment({ runtimes: [{ name: 'Python', command: 'python', version: '3.10.12', available: true }] }),
      [
        parsedRequirements([
          requirement({ ecosystem: 'python', type: 'runtime-version', name: 'python', versionConstraint: '>=3.11', sourceFile: 'backend/pyproject.toml' }),
        ]),
      ]
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]?.category).toBe('runtime');
    expect(diags[0]?.severity).toBe('error');
    expect(diags[0]?.affectedFiles).toContain('backend/pyproject.toml');
  });

  it('should stay silent when the go toolchain satisfies the directive', async () => {
    const engine = createDiagnosticEngine();
    const diags = await engine.runDiagnosticsWithContext(
      workspace(),
      environment({
        devTools: [],
        runtimes: [{ name: 'Go', command: 'go', version: '1.22.1', available: true }],
      }),
      [
        parsedRequirements([
          requirement({ ecosystem: 'go', type: 'runtime-version', name: 'go', versionConstraint: '1.22', sourceFile: 'go.mod' }),
        ]),
      ]
    );
    expect(diags).toHaveLength(0);
  });

  it('should surface dotnet target framework mismatches', async () => {
    const engine = createDiagnosticEngine();
    const diags = await engine.runDiagnosticsWithContext(
      workspace(),
      environment({ runtimes: [{ name: '.NET', command: 'dotnet', version: '6.0.100', available: true }] }),
      [
        parsedRequirements([
          requirement({ ecosystem: 'dotnet', type: 'runtime-version', name: 'dotnet', versionConstraint: 'net8.0', sourceFile: 'app.csproj' }),
        ]),
      ]
    );
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags.some((diag) => diag.category === 'runtime')).toBe(true);
  });

  it('should diagnose maven dependencies resolved through properties', async () => {
    const engine = createDiagnosticEngine();
    const diags = await engine.runDiagnosticsWithContext(
      workspace(),
      environment(),
      [
        parsedRequirements([
          requirement({
            ecosystem: 'java',
            type: 'package-dependency',
            name: 'com.fasterxml.jackson.core:jackson-databind',
            versionConstraint: '2.16.0',
            sourceFile: 'pom.xml',
          }),
        ]),
      ]
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]?.category).toBe('dependency');
    expect(diags[0]?.requirement?.name).toBe('com.fasterxml.jackson.core:jackson-databind');
  });

  it('should represent go replacements explicitly in parsed requirements', async () => {
    const engine = createDiagnosticEngine();
    const diags = await engine.runDiagnosticsWithContext(
      workspace(),
      environment(),
      [
        parsedRequirements([
          {
            id: 'req-replace',
            ecosystem: 'go',
            type: 'custom',
            name: 'golang.org/x/text (replace)',
            versionConstraint: 'golang.org/x/text v0.15.0',
            rawConstraint: 'golang.org/x/text => golang.org/x/text v0.15.0',
            sourceFile: 'go.mod',
            sourceSection: 'replace directive',
          },
        ]),
      ]
    );
    expect(diags).toHaveLength(0);
  });

  it('should deduplicate identical requirements across nested projects', async () => {
    const engine = createDiagnosticEngine();
    const first = requirement({ name: 'axios', versionConstraint: '^1.7.0', sourceFile: 'package.json' });
    const second = requirement({ name: 'axios', versionConstraint: '^1.7.0', sourceFile: 'apps/web/package.json' });
    const diags = await engine.runDiagnosticsWithContext(
      workspace(),
      environment(),
      [parsedRequirements([first]), parsedRequirements([second])]
    );
    expect(diags).toHaveLength(1);
  });

  it('should carry lockfile resolution evidence for pinned packages', async () => {
    const engine = createDiagnosticEngine();
    const diags = await engine.runDiagnosticsWithContext(
      workspace(),
      environment(),
      [
        parsedRequirements([
          {
            ...requirement({ name: 'serde', versionConstraint: '==1.0.197', sourceFile: 'Cargo.lock' }),
            ecosystem: 'rust',
            resolvedVersion: '1.0.197',
            origin: 'lockfile',
            lockfileSource: 'Cargo.lock',
          },
        ]),
      ]
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]?.requirement).toMatchObject({ resolvedVersion: '1.0.197', origin: 'lockfile' });
  });

  it('should keep workspace member declarations visible without diagnostics noise', async () => {
    const engine = createDiagnosticEngine();
    const diags = await engine.runDiagnosticsWithContext(
      workspace(),
      environment(),
      [
        parsedRequirements([
          {
            id: 'req-member',
            ecosystem: 'rust',
            type: 'custom',
            name: 'workspace member crates/api',
            sourceFile: 'Cargo.toml',
            sourceSection: 'workspace.members',
          },
        ]),
      ]
    );
    expect(diags).toHaveLength(0);
  });
});

describe('cross-project divergence', () => {
  function runtimeReq(ecosystem: string, name: string, constraint: string, file: string): ProjectRequirement {
    return requirement({ ecosystem, type: 'runtime-version', name, versionConstraint: constraint, sourceFile: file });
  }

  it('should note exact-version divergence across projects', async () => {
    const engine = createDiagnosticEngine();
    const diags = await engine.runDiagnosticsWithContext(
      workspace(),
      environment(),
      [
        parsedRequirements([runtimeReq('node', 'node', '18.0.0', 'package.json')]),
        parsedRequirements([runtimeReq('node', 'node', '20.0.0', 'apps/web/package.json')]),
      ]
    );
    const notes = diags.filter((diag) => diag.code === 'CROSS_PROJECT_RUNTIME_DIVERGENCE');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.severity).toBe('info');
    expect(notes[0]?.affectedFiles).toHaveLength(2);
  });

  it('should ignore overlapping ranges across projects', async () => {
    const engine = createDiagnosticEngine();
    const diags = await engine.runDiagnosticsWithContext(
      workspace(),
      environment(),
      [
        parsedRequirements([runtimeReq('node', 'node', '>=18.0.0', 'package.json')]),
        parsedRequirements([runtimeReq('node', 'node', '>=20.0.0', 'apps/web/package.json')]),
      ]
    );
    expect(diags.filter((diag) => diag.code === 'CROSS_PROJECT_RUNTIME_DIVERGENCE')).toHaveLength(0);
  });

  it('should ignore a single project pin', async () => {
    const engine = createDiagnosticEngine();
    const diags = await engine.runDiagnosticsWithContext(
      workspace(),
      environment(),
      [parsedRequirements([runtimeReq('node', 'node', '18.0.0', 'package.json')])]
    );
    expect(diags.filter((diag) => diag.code === 'CROSS_PROJECT_RUNTIME_DIVERGENCE')).toHaveLength(0);
  });
});

describe('ecosystem-aware version matching', () => {
  it('should strip leading v prefixes', () => {
    expect(versionMatcher.matches('>=1.22', 'v1.22.1').satisfied).toBe(true);
    expect(versionMatcher.matches('==v1.2.3', '1.2.3').satisfied).toBe(true);
  });

  it('should support unions and hyphen ranges', () => {
    expect(versionMatcher.matches('^1.0.0 || ^2.0.0', '2.1.0').satisfied).toBe(true);
    expect(versionMatcher.matches('^1.0.0 || ^2.0.0', '3.0.0').satisfied).toBe(false);
    expect(versionMatcher.matches('1.2.3 - 2.3.4', '2.0.0').satisfied).toBe(true);
    expect(versionMatcher.matches('1.2.3 - 2.3.4', '2.5.0').satisfied).toBe(false);
  });

  it('should support maven version ranges', () => {
    expect(versionMatcher.matches('[1.0,2.0)', '1.5.0').satisfied).toBe(true);
    expect(versionMatcher.matches('[1.0,2.0)', '2.0.0').satisfied).toBe(false);
    expect(versionMatcher.matches('[1.0]', '1.0.0').satisfied).toBe(true);
    expect(versionMatcher.matches('(,1.0]', '0.9.0').satisfied).toBe(true);
    expect(versionMatcher.matches('(1.0,)', '1.0.0').satisfied).toBe(false);
    expect(versionMatcher.matches('(1.0,)', '1.0.1').satisfied).toBe(true);
  });

  it('should support wildcards, gradle plus ranges, and npm aliases', () => {
    expect(versionMatcher.matches('1.2.x', '1.2.9').satisfied).toBe(true);
    expect(versionMatcher.matches('1.2.x', '1.3.0').satisfied).toBe(false);
    expect(versionMatcher.matches('1.*', '1.9.9').satisfied).toBe(true);
    expect(versionMatcher.matches('1.+', '1.4.0').satisfied).toBe(true);
    expect(versionMatcher.matches('1.+', '2.0.0').satisfied).toBe(false);
    expect(versionMatcher.matches('latest.integration', '9.9.9').satisfied).toBe(true);
  });

  it('should support PEP 440 arbitrary equality and compatible releases', () => {
    expect(versionMatcher.matches('===1.2.3', '1.2.3').satisfied).toBe(true);
    expect(versionMatcher.matches('~=1.4', '1.9.0').satisfied).toBe(true);
    expect(versionMatcher.matches('~=1.4', '2.0.0').satisfied).toBe(false);
    expect(versionMatcher.matches('~=1.4.2', '1.4.9').satisfied).toBe(true);
  });

  it('should preserve existing operator behavior', () => {
    expect(versionMatcher.matches('>=18.0.0', '20.5.0').satisfied).toBe(true);
    expect(versionMatcher.matches('>=18.0.0', '16.0.0').satisfied).toBe(false);
    expect(versionMatcher.matches('^1.2.3', '2.0.0').satisfied).toBe(false);
    expect(versionMatcher.matches('~1.2.3', '1.3.0').satisfied).toBe(false);
    expect(versionMatcher.matches('*', '9.9.9').satisfied).toBe(true);
  });
});
