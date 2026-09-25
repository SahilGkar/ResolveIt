import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { scanRequirements } from '../src/requirements/index.js';
import type { ParsedRequirements, ProjectRequirement } from '../src/core/models.js';
import { PythonRequirementParser } from '../src/requirements/parsers/python.js';
import { DeterministicRepairPlanner } from '../src/agent/deterministic-planner.js';
import { assignProject, matchesManifestPattern, stableProjectId } from '../src/requirements/projects.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ecosystems');

function reqs(results: ReadonlyArray<ParsedRequirements>): ProjectRequirement[] {
  return results.flatMap((result) => [...result.requirements]);
}

function byFile(results: ReadonlyArray<ParsedRequirements>, suffix: string): ProjectRequirement[] {
  return reqs(results.filter((result) => (result.sourceFiles[0] ?? '').endsWith(suffix)));
}

function find(
  requirements: ReadonlyArray<ProjectRequirement>,
  predicate: (req: ProjectRequirement) => boolean
): ProjectRequirement {
  const found = requirements.find(predicate);
  expect(found, 'expected requirement to exist').toBeDefined();
  return found as ProjectRequirement;
}

function stripVolatile(results: ReadonlyArray<ParsedRequirements>): unknown {
  return results.map((result) => ({
    ...result,
    projectId: '<id>',
    requirements: result.requirements.map((req) => ({ ...req, id: '<id>' })),
  }));
}

describe('project ownership helpers', () => {
  it('should match manifest patterns with wildcards', () => {
    expect(matchesManifestPattern('package.json', 'package.json')).toBe(true);
    expect(matchesManifestPattern('app.csproj', '*.csproj')).toBe(true);
    expect(matchesManifestPattern('requirements-dev.txt', 'requirements-*.txt')).toBe(true);
    expect(matchesManifestPattern('other.txt', 'requirements-*.txt')).toBe(false);
    expect(matchesManifestPattern('Package.JSON', 'package.json')).toBe(true);
  });

  it('should produce stable project ids', () => {
    expect(stableProjectId('.')).toBe('root');
    expect(stableProjectId('services/api')).toBe('services-api');
    expect(stableProjectId('services/api')).toBe(stableProjectId('services/api'));
  });

  it('should assign files to the nearest marker directory', () => {
    expect(assignProject('package.json', ['.'])).toEqual({ projectId: 'root', projectRoot: '.' });
    expect(assignProject('apps/web/package.json', ['.', 'apps/web'])).toEqual({
      projectId: 'apps-web',
      projectRoot: 'apps/web',
    });
    expect(assignProject('services/api/go.mod', ['frontend', 'services/api'])).toEqual({
      projectId: 'services-api',
      projectRoot: 'services/api',
    });
    expect(assignProject('docs/readme.md', [])).toEqual({ projectId: 'root', projectRoot: '.' });
  });
});

describe('python fixtures', () => {
  it('should parse PEP 621 arrays, markers, optionals, and requirements.txt', async () => {
    const results = await scanRequirements(join(FIXTURES, 'python-basic'));
    const all = reqs(results);

    const runtime = find(all, (req) => req.type === 'runtime-version' && req.name === 'python');
    expect(runtime.versionConstraint).toBe('>=3.11');

    const requests = find(all, (req) => req.name === 'requests' && req.sourceFile.endsWith('pyproject.toml'));
    expect(requests.versionConstraint).toBe('>=2.31');

    const uvicorn = find(all, (req) => req.name === 'uvicorn');
    expect(uvicorn.versionConstraint).toBe('>=0.24');
    expect(uvicorn.metadata).toMatchObject({ environmentMarker: expect.stringContaining('python_version') });

    const dev = find(all, (req) => req.name === 'pytest');
    expect(dev.developmentOnly).toBe(true);
    expect(dev.optional).toBe(true);

    const txt = find(all, (req) => req.name === 'gunicorn');
    expect(txt.metadata).toMatchObject({ environmentMarker: expect.stringContaining('sys_platform') });
    expect(all.some((req) => req.name.includes('-r'))).toBe(false);
  });

  it('should parse poetry sections, groups, and lockfiles', async () => {
    const results = await scanRequirements(join(FIXTURES, 'python-poetry'));
    const all = reqs(results);

    const runtime = find(all, (req) => req.type === 'runtime-version' && req.sourceSection === 'tool.poetry.dependencies.python');
    expect(runtime.versionConstraint).toBe('^3.11');

    const pytest = find(all, (req) => req.name === 'pytest');
    expect(pytest.developmentOnly).toBe(true);

    const locked = find(all, (req) => req.name === 'requests' && req.origin === 'lockfile');
    expect(locked.resolvedVersion).toBe('2.32.5');
    expect(locked.lockfileSource).toBe('poetry-lock');
  });

  it('should parse setup.cfg and static setup.py', async () => {
    const results = await scanRequirements(join(FIXTURES, 'python-legacy'));
    const all = reqs(results);

    expect(find(all, (req) => req.name === 'requests' && req.sourceFile.endsWith('setup.cfg')).versionConstraint).toBe('>=2');
    expect(find(all, (req) => req.type === 'runtime-version' && req.sourceFile.endsWith('setup.py')).versionConstraint).toBe('>=3.9');
    expect(find(all, (req) => req.name === 'flask' && req.sourceFile.endsWith('setup.py')).versionConstraint).toBe('==3.0.0');
  });

  it('should warn on dynamic setup.py instead of executing it', () => {
    const parser = new PythonRequirementParser();
    const result = parser.parse('setup.py', 'from setuptools import setup\nsetup(name="x", install_requires=read_reqs())\n');
    expect(result.requirements).toHaveLength(0);
    expect(result.parseErrors.some((err) => err.code === 'DYNAMIC_DECLARATION')).toBe(true);
  });
});

describe('node fixtures', () => {
  it('should parse scopes, engines, packageManager, volta, and package-lock', async () => {
    const results = await scanRequirements(join(FIXTURES, 'node-npm'));
    const all = reqs(results);

    expect(find(all, (req) => req.name === 'axios').metadata).toMatchObject({ scope: 'production' });
    expect(find(all, (req) => req.name === 'vitest').developmentOnly).toBe(true);
    expect(find(all, (req) => req.name === 'react').metadata).toMatchObject({ scope: 'peer' });
    expect(find(all, (req) => req.type === 'runtime-version' && req.sourceSection === 'engines.node').versionConstraint).toBe('>=18.0.0');
    expect(find(all, (req) => req.sourceSection === 'volta.node').versionConstraint).toBe('==20.11.0');
    expect(find(all, (req) => req.sourceSection === 'volta.npm').versionConstraint).toBe('==10.2.4');

    const lockedAxios = find(all, (req) => req.name === 'axios' && req.origin === 'lockfile');
    expect(lockedAxios.resolvedVersion).toBe('1.7.4');
    const lockedVitest = find(all, (req) => req.name === 'vitest' && req.origin === 'lockfile');
    expect(lockedVitest.developmentOnly).toBe(true);
  });

  it('should parse pnpm importer ranges with resolved versions', async () => {
    const results = await scanRequirements(join(FIXTURES, 'node-pnpm'));
    const all = reqs(results);

    const axios = find(all, (req) => req.name === 'axios' && req.sourceSection === 'dependencies.axios');
    expect(axios.versionConstraint).toBe('^1.7.0');
    expect(axios.resolvedVersion).toBe('1.7.4');
    expect(axios.origin).toBe('lockfile');
    const lockedAxios = byFile(results, 'pnpm-lock.yaml').filter((req) => req.name === 'axios');
    expect(lockedAxios).toHaveLength(1);
  });

  it('should parse yarn v1 entries', async () => {
    const results = await scanRequirements(join(FIXTURES, 'node-yarn'));
    const all = reqs(results);

    const lodash = find(all, (req) => req.name === 'lodash' && req.origin === 'lockfile');
    expect(lodash.resolvedVersion).toBe('4.17.21');
    expect(lodash.versionConstraint).toBe('^4.17.21');
  });
});

describe('java fixtures', () => {
  it('should resolve maven properties and skip managed-only dependencies', async () => {
    const results = await scanRequirements(join(FIXTURES, 'java-maven'));
    const all = reqs(results);

    const jackson = find(all, (req) => req.name === 'com.fasterxml.jackson.core:jackson-databind');
    expect(jackson.versionConstraint).toBe('2.16.0');
    expect(jackson.rawConstraint).toBe('${jackson.version}');

    expect(all.some((req) => req.name.includes('jackson-bom'))).toBe(false);

    const parent = find(all, (req) => req.type === 'custom' && req.sourceSection === 'parent');
    expect(parent.versionConstraint).toBe('3.2.0');

    const junit = find(all, (req) => req.name === 'junit:junit');
    expect(junit.developmentOnly).toBe(true);

    const wrapper = find(all, (req) => req.type === 'toolchain' && req.name === 'maven');
    expect(wrapper.versionConstraint).toBe('3.9.6');
  });

  it('should parse gradle toolchain, configurations, catalog, and wrapper without duplicates', async () => {
    const results = await scanRequirements(join(FIXTURES, 'java-gradle'));
    const all = reqs(results);

    expect(find(all, (req) => req.sourceSection === 'java.toolchain').versionConstraint).toBe('17');

    const guava = all.filter((req) => req.name === 'com.google.guava:guava');
    expect(guava).toHaveLength(2);
    expect(guava.map((req) => req.sourceSection).sort()).toEqual(['dependencies.implementation', 'libraries.guava']);

    const lombok = find(all, (req) => req.name === 'org.projectlombok:lombok');
    expect(lombok.metadata).toMatchObject({ dynamic: true });

    const junit = find(all, (req) => req.name === 'junit:junit' && req.sourceSection === 'libraries.junit');
    expect(junit.versionConstraint).toBe('4.13.2');

    expect(find(all, (req) => req.name === 'gradle' && req.type === 'toolchain').versionConstraint).toBe('8.5');
  });
});

describe('go fixtures', () => {
  it('should parse directives, indirect markers, replace, and exclude without duplication', async () => {
    const results = await scanRequirements(join(FIXTURES, 'go-module'));
    const all = reqs(results);

    expect(find(all, (req) => req.type === 'runtime-version').versionConstraint).toBe('1.22');
    expect(find(all, (req) => req.type === 'toolchain').versionConstraint).toBe('go1.22.1');

    expect(all.filter((req) => req.name === 'github.com/spf13/cobra')).toHaveLength(1);

    const indirect = find(all, (req) => req.name === 'golang.org/x/text' && req.type === 'package-dependency');
    expect(indirect.origin).toBe('transitive');
    expect(indirect.metadata).toMatchObject({ indirect: true });

    const replace = find(all, (req) => req.type === 'custom' && (req.rawConstraint ?? '').includes('=>'));
    expect(replace.name).toContain('golang.org/x/text');

    expect(all.some((req) => req.type === 'custom' && req.name.includes('(exclude)'))).toBe(true);
  });

  it('should attribute go.work and member modules to their projects', async () => {
    const results = await scanRequirements(join(FIXTURES, 'go-workspace'));
    const work = byFile(results, 'go.work');
    expect(work.some((req) => req.sourceSection === 'use block')).toBe(true);

    const member = byFile(results, 'api/go.mod');
    expect(member.length).toBeGreaterThan(0);
    const owners = new Set(results.map((result) => result.projectRoot));
    expect(owners.has('api')).toBe(true);
  });
});

describe('rust fixtures', () => {
  it('should parse edition, hyphenated deps, inheritance, members, and lockfiles', async () => {
    const results = await scanRequirements(join(FIXTURES, 'rust-workspace'));
    const all = reqs(results);

    expect(find(all, (req) => req.type === 'language-version').versionConstraint).toBe('2021');
    expect(find(all, (req) => req.name === 'serde-json').versionConstraint).toBe('1.0.108');

    const inherited = find(all, (req) => req.name === 'serde' && req.metadata?.inherited === true);
    expect(inherited.versionConstraint).toBeUndefined();

    expect(all.filter((req) => req.sourceSection === 'workspace.members')).toHaveLength(2);

    const locked = find(all, (req) => req.name === 'serde' && req.origin === 'lockfile');
    expect(locked.resolvedVersion).toBe('1.0.197');

    expect(find(all, (req) => req.name === 'criterion').developmentOnly).toBe(true);
  });
});

describe('c++ fixtures', () => {
  it('should parse cmake versions, standards, components, and vcpkg', async () => {
    const results = await scanRequirements(join(FIXTURES, 'cpp-cmake'));
    const all = reqs(results);

    expect(find(all, (req) => req.name === 'cmake').versionConstraint).toBe('3.27');
    expect(find(all, (req) => req.name === 'c++').versionConstraint).toBe('20');
    expect(find(all, (req) => req.name === 'c').versionConstraint).toBe('17');

    const boost = find(all, (req) => req.name === 'Boost');
    expect(boost.versionConstraint).toBe('1.84');
    expect(boost.metadata).toMatchObject({ components: ['system', 'filesystem'] });

    const openssl = find(all, (req) => req.name === 'OpenSSL');
    expect(openssl.versionConstraint).toBeUndefined();

    expect(find(all, (req) => req.name === 'spdlog').versionConstraint).toBe('1.13.0');
    expect(find(all, (req) => req.name === 'vcpkg-baseline').versionConstraint).toBeDefined();
  });

  it('should parse meson, conan, and project metadata', async () => {
    const results = await scanRequirements(join(FIXTURES, 'cpp-meson'));
    const all = reqs(results);

    expect(find(all, (req) => req.name === 'meson').versionConstraint).toBe('>=1.3.0');
    const fmt = find(all, (req) => req.name === 'fmt' && req.sourceFile.endsWith('meson.build'));
    expect(fmt.versionConstraint).toBe('>=10.0.0');
    expect(fmt.metadata).toMatchObject({ fallback: 'fmt' });
    expect(find(all, (req) => req.name === 'fmt' && req.sourceFile.endsWith('conanfile.txt')).versionConstraint).toBe('10.2.1');
  });
});

describe('ruby and php fixtures', () => {
  it('should parse gems, groups, and lockfiles', async () => {
    const results = await scanRequirements(join(FIXTURES, 'ruby'));
    const all = reqs(results);

    expect(find(all, (req) => req.type === 'runtime-version').versionConstraint).toBe('3.2.2');
    expect(find(all, (req) => req.name === 'pg').versionConstraint).toBe('>= 1.0, < 2.0');
    expect(find(all, (req) => req.name === 'rubocop').developmentOnly).toBe(true);

    const locked = find(all, (req) => req.name === 'rails' && req.origin === 'lockfile');
    expect(locked.resolvedVersion).toBe('7.1.3');
    expect(find(all, (req) => req.sourceSection === 'BUNDLED WITH').versionConstraint).toBe('2.4.22');
  });

  it('should parse composer packages, extensions, and both lock sections', async () => {
    const results = await scanRequirements(join(FIXTURES, 'php'));
    const all = reqs(results);

    expect(find(all, (req) => req.type === 'runtime-version').versionConstraint).toBe('>=8.2');
    expect(find(all, (req) => req.name === 'ext-mbstring').type).toBe('system-tool');
    expect(find(all, (req) => req.name === 'phpunit/phpunit' && !req.origin).developmentOnly).toBe(true);

    const locked = find(all, (req) => req.name === 'monolog/monolog' && req.origin === 'lockfile');
    expect(locked.resolvedVersion).toBe('3.5.0');
    const lockedDev = find(all, (req) => req.name === 'phpunit/phpunit' && req.origin === 'lockfile');
    expect(lockedDev.developmentOnly).toBe(true);
  });
});

describe('dotnet fixtures', () => {
  it('should parse frameworks, references, SDK pins, CPM, solutions, and legacy configs', async () => {
    const results = await scanRequirements(join(FIXTURES, 'dotnet'));
    const all = reqs(results);

    expect(find(all, (req) => req.sourceSection === 'TargetFramework').versionConstraint).toBe('net8.0');
    expect(find(all, (req) => req.name === 'Newtonsoft.Json' && !req.origin).versionConstraint).toBe('13.0.3');
    expect(find(all, (req) => req.sourceSection === 'sdk.version').versionConstraint).toBe('8.0.100');
    expect(find(all, (req) => req.sourceSection === 'PackageVersion').versionConstraint).toBe('3.1.1');
    expect(find(all, (req) => req.sourceSection === 'Project()').metadata).toMatchObject({ projectPath: 'app.csproj' });

    const legacy = find(all, (req) => req.sourceFile.endsWith('packages.config'));
    expect(legacy.origin).toBe('lockfile');
    expect(legacy.resolvedVersion).toBe('12.0.3');
  });
});

describe('docker fixtures', () => {
  it('should parse stages, digests, registries, args, and compose builds', async () => {
    const results = await scanRequirements(join(FIXTURES, 'docker'));
    const all = reqs(results);

    const base = find(all, (req) => req.name === 'node' && req.sourceSection === 'FROM');
    expect(base.metadata).toMatchObject({ platform: 'linux/amd64' });

    const registry = find(all, (req) => req.name === 'registry.example.com:5000/team/app');
    expect(registry.versionConstraint).toBe('1.2.3');

    const pinned = find(all, (req) => req.name === 'postgres' && req.sourceSection === 'FROM');
    expect(pinned.metadata).toMatchObject({ pinned: true });

    expect(find(all, (req) => req.sourceSection === 'ARG').versionConstraint).toBe('20.11.0');

    const build = find(all, (req) => req.sourceSection === 'services.web.build');
    expect(build.rawConstraint).toBe('build:');
    expect(find(all, (req) => req.sourceSection === 'services.web.build.dockerfile').rawConstraint).toBe('Dockerfile');

    expect(find(all, (req) => req.name === 'registry.example.com:5000/team/postgres').versionConstraint).toBe('15.4');
  });
});

describe('multi-project aggregation', () => {
  it('should discover manifests with relative workspace roots', async () => {
    const relativeRoot = join('tests', 'fixtures', 'ecosystems', 'multi-project');
    const results = await scanRequirements(relativeRoot);
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.sourceFiles[0]).not.toMatch(/^[a-z]-project/i);
      expect(result.parseErrors.filter((err) => err.code === 'READ_ERROR')).toHaveLength(0);
    }
    const roots = new Set(results.map((result) => result.projectRoot));
    expect(roots.has('frontend')).toBe(true);
  });
  it('should attribute each manifest to its own project without cross-contamination', async () => {
    const results = await scanRequirements(join(FIXTURES, 'multi-project'));
    const roots = new Set(results.map((result) => result.projectRoot));
    expect(roots.has('frontend')).toBe(true);
    expect(roots.has('backend')).toBe(true);
    expect(roots.has('services/api')).toBe(true);

    const frontend = byFile(results, 'frontend/package.json');
    expect(frontend.some((req) => req.name === 'axios')).toBe(true);
    expect(frontend.some((req) => req.name === 'fastapi')).toBe(false);

    const backend = byFile(results, 'backend/pyproject.toml');
    expect(backend.some((req) => req.name === 'fastapi')).toBe(true);
    expect(backend.some((req) => req.name === 'axios')).toBe(false);

    for (const result of results) {
      expect(result.projectId).not.toBe('unknown');
    }
  });

  it('should keep nested projects separate from their parents', async () => {
    const results = await scanRequirements(join(FIXTURES, 'nested'));

    const atRoot = results.filter((result) => result.sourceFiles[0] === 'package.json');
    const webOwned = byFile(results, 'apps/web/package.json');
    const adminOwned = byFile(results, 'apps/admin/package.json');

    expect(atRoot.flatMap((result) => [...result.requirements]).some((req) => req.name === 'axios')).toBe(true);
    expect(atRoot.flatMap((result) => [...result.requirements]).some((req) => req.name === 'react')).toBe(false);
    expect(webOwned.some((req) => req.name === 'react')).toBe(true);
    expect(adminOwned.some((req) => req.name === 'vue')).toBe(true);

    const owners = new Map<string, string>();
    for (const result of results) {
      owners.set(result.sourceFiles[0] ?? '', result.projectRoot ?? '');
    }
    expect(owners.get('apps/web/package.json')).toBe('apps/web');
    expect(owners.get('apps/admin/package.json')).toBe('apps/admin');
  });

  it('should emit results in deterministic source order', async () => {
    const results = await scanRequirements(join(FIXTURES, 'multi-project'));
    const files = results.map((result) => result.sourceFiles[0] ?? '');
    expect([...files].sort()).toEqual(files);
  });

  it('should produce identical output across repeated scans', async () => {
    const first = await scanRequirements(join(FIXTURES, 'multi-project'));
    const second = await scanRequirements(join(FIXTURES, 'multi-project'));
    expect(stripVolatile(second)).toEqual(stripVolatile(first));
  });
});

describe('malformed input robustness', () => {
  it('should isolate parse failures per file without crashing', async () => {
    const results = await scanRequirements(join(FIXTURES, 'malformed'));
    const errors = results.flatMap((result) => [...result.parseErrors]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((err) => err.severity === 'error')).toBe(true);

    const all = reqs(results);
    expect(all.some((req) => req.name === 'requests')).toBe(true);
    expect(all.some((req) => req.name === 'flask')).toBe(true);
  });
});

describe('aggregation performance', () => {
  it('should parse thousands of requirements within a generous bound', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'resolveit-perf-'));
    try {
      const lines: string[] = [];
      for (let i = 0; i < 3000; i++) {
        lines.push(`package-${i}>=1.${i % 10}`);
      }
      await writeFile(join(workspaceRoot, 'requirements.txt'), lines.join('\n'), 'utf-8');
      const started = Date.now();
      const results = await scanRequirements(workspaceRoot);
      const elapsed = Date.now() - started;
      expect(reqs(results)).toHaveLength(3000);
      expect(elapsed).toBeLessThan(10000);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 30000);
});

describe('agent planner compatibility', () => {
  it('should not propose installs for lockfile or indirect dependencies', async () => {
    const planner = new DeterministicRepairPlanner();
    const analysis = {
      observation: {} as never,
      diagnostics: [
        {
          id: 'diag-lock',
          code: 'DEPENDENCY_X',
          severity: 'error',
          category: 'dependency',
          title: 'locked',
          message: 'locked dep',
          evidence: [],
          source: 'dependency-resolver',
          timestamp: new Date(),
          metadata: {},
          requirement: {
            id: 'req-lock',
            ecosystem: 'node',
            type: 'package-dependency',
            name: 'axios',
            versionConstraint: '==1.7.4',
            sourceFile: 'package-lock.json',
            origin: 'lockfile',
          },
        },
        {
          id: 'diag-indirect',
          code: 'DEPENDENCY_X',
          severity: 'error',
          category: 'dependency',
          title: 'indirect',
          message: 'indirect dep',
          evidence: [],
          source: 'dependency-resolver',
          timestamp: new Date(),
          metadata: {},
          requirement: {
            id: 'req-indirect',
            ecosystem: 'go',
            type: 'package-dependency',
            name: 'golang.org/x/text',
            versionConstraint: 'v0.14.0',
            sourceFile: 'go.mod',
            metadata: { indirect: true },
          },
        },
      ],
      blockingDiagnostics: [],
      timestamp: new Date(),
    };
    analysis.blockingDiagnostics = [...analysis.diagnostics];
    const result = await planner.createPlan({ analysis: analysis as never, workspaceRoot: '/tmp/ws' });
    expect(result.plan.actions).toHaveLength(0);
    expect(result.manualActions).toHaveLength(2);
  });
});
