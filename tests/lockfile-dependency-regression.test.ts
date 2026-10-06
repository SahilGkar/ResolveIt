import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createDiagnosticEngine,
  createRepairPlanner,
  scanRequirements,
  scanWorkspace,
  scanEnvironment,
} from '../src/index.js';
import type {
  Diagnostic,
  ParsedRequirements,
  PlanContext,
  ProjectRequirement,
  RepairAction,
  RepairPlan,
  Workspace,
} from '../src/index.js';
import { InstallDependencyTool } from '../src/repair/tools/install-dependency.js';

/**
 * Regression coverage for the "196 install-dependency actions" defect.
 *
 * A lockfile enumerates the entire resolved dependency tree, most of which is
 * transitive. Those entries are managed through the manifest and the package
 * manager; proposing an individual `npm install` for each of them is both wrong
 * and unsafe. These tests assert the planner output itself rather than merely
 * asserting that a filter exists.
 */

/** Transitive packages that were previously turned into individual repair actions. */
const TRANSITIVE_PACKAGES = [
  '@jridgewell/gen-mapping',
  '@jridgewell/resolve-uri',
  '@jridgewell/set-array',
  '@jridgewell/source-map',
  '@jridgewell/trace-mapping',
  'streamsearch',
  'zwitch',
  'lru-cache',
  'yallist',
];

/** Genuine direct dependencies that must still produce install actions. */
const DIRECT_PACKAGES = ['commander', 'lodash'];

interface Fixture {
  readonly root: string;
  readonly workspace: Workspace;
  readonly requirements: ReadonlyArray<ParsedRequirements>;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), 'utf-8');
}

async function makeFixture(options: { lockfile: boolean }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'resolveit-lockfile-regression-'));

  await writeJson(join(root, 'package.json'), {
    name: 'lockfile-regression',
    version: '1.0.0',
    dependencies: Object.fromEntries(DIRECT_PACKAGES.map((name) => [name, '^1.0.0'])),
  });

  if (options.lockfile) {
    const packages: Record<string, unknown> = {
      '': { name: 'lockfile-regression', version: '1.0.0' },
    };
    for (const name of DIRECT_PACKAGES) {
      packages[`node_modules/${name}`] = { version: '1.0.0' };
    }
    for (const name of TRANSITIVE_PACKAGES) {
      packages[`node_modules/${name}`] = { version: '0.1.0' };
    }
    await writeJson(join(root, 'package-lock.json'), {
      name: 'lockfile-regression',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages,
    });
  }

  const workspace = await scanWorkspace(root, { maxDepth: 10, maxFiles: 1000 });
  const requirements = await scanRequirements(root, { timeout: 20000 });
  return { root, workspace, requirements };
}

function planContext(workspace: Workspace): PlanContext {
  return {
    workspace,
    diagnosis: {
      id: 'diag-regression',
      summary: 'regression',
      rootCauses: [],
      confidence: 1,
      timestamp: new Date(),
    },
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
  };
}

async function diagnoseFixture(fixture: Fixture): Promise<ReadonlyArray<Diagnostic>> {
  const engine = createDiagnosticEngine();
  const environment = await scanEnvironment({ timeout: 20000 });
  return engine.runDiagnosticsWithContext(fixture.workspace, environment, fixture.requirements);
}

function installedPackages(diagnostics: ReadonlyArray<Diagnostic>): string[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.category === 'dependency' && diagnostic.requirement?.type === 'package-dependency')
    .map((diagnostic) => diagnostic.requirement?.name ?? '')
    .filter((name) => name.length > 0);
}

function installActions(plan: RepairPlan): ReadonlyArray<RepairAction> {
  return plan.actions.filter((action) => action.type === 'install-dependency');
}

function installedPackagesOf(actions: ReadonlyArray<RepairAction>): string[] {
  return actions
    .map((action) => action.parameters['package'])
    .filter((value): value is string => typeof value === 'string');
}

let lockfileFixture: Fixture;
let manifestOnlyFixture: Fixture;

beforeAll(async () => {
  lockfileFixture = await makeFixture({ lockfile: true });
  manifestOnlyFixture = await makeFixture({ lockfile: false });
}, 60000);

afterAll(async () => {
  await rm(lockfileFixture.root, { recursive: true, force: true });
  await rm(manifestOnlyFixture.root, { recursive: true, force: true });
});

describe('requirement parsing marks lockfile entries as lockfile origin', () => {
  it('should classify lockfile packages as origin=lockfile', () => {
    const all = lockfileFixture.requirements.flatMap((parsed) => [...parsed.requirements]);
    for (const name of TRANSITIVE_PACKAGES) {
      const requirement: ProjectRequirement | undefined = all.find((entry) => entry.name === name);
      expect(requirement, `expected ${name} to be discovered from the lockfile`).toBeDefined();
      expect(requirement?.origin).toBe('lockfile');
    }
  });
});

describe('dependency diagnostic rule remediation candidates', () => {
  it('should not offer install remediation for lockfile packages', async () => {
    const diagnostics = await diagnoseFixture(lockfileFixture);
    const names = installedPackages(diagnostics);

    for (const name of TRANSITIVE_PACKAGES) {
      expect(names, `${name} should be reported as a dependency diagnostic`).toContain(name);
    }

    for (const name of TRANSITIVE_PACKAGES) {
      const diagnostic = diagnostics.find(
        (entry) => entry.requirement?.name === name && entry.category === 'dependency'
      );
      const installs = (diagnostic?.remediationCandidates ?? []).filter(
        (candidate) => candidate.type === 'install-dependency'
      );
      expect(installs, `${name} must not offer an install-dependency remediation`).toEqual([]);
    }
  }, 60000);
});

describe('RepairPlannerImpl output for lockfile trees', () => {
  it('should not propose installing transitive lockfile packages', async () => {
    const diagnostics = await diagnoseFixture(lockfileFixture);
    const planner = createRepairPlanner();
    const plan = await planner.createPlan(diagnostics, planContext(lockfileFixture.workspace));

    const packages = installedPackagesOf(installActions(plan));

    for (const name of TRANSITIVE_PACKAGES) {
      expect(packages, `${name} must not become a direct install action`).not.toContain(name);
    }
  }, 60000);

  it('should keep the plan small rather than one action per lockfile entry', async () => {
    const diagnostics = await diagnoseFixture(lockfileFixture);
    const planner = createRepairPlanner();
    const plan = await planner.createPlan(diagnostics, planContext(lockfileFixture.workspace));

    const dependencyCount = installedPackages(diagnostics).length;
    expect(dependencyCount).toBeGreaterThanOrEqual(TRANSITIVE_PACKAGES.length);
    // The original defect produced roughly one action per lockfile entry.
    expect(installActions(plan).length).toBeLessThan(dependencyCount);
  }, 60000);
});

describe('RepairPlannerImpl output for direct dependencies', () => {
  it('should still propose installs for genuine direct dependencies', async () => {
    const diagnostics = await diagnoseFixture(manifestOnlyFixture);
    const planner = createRepairPlanner();
    const plan = await planner.createPlan(diagnostics, planContext(manifestOnlyFixture.workspace));

    const packages = installedPackagesOf(installActions(plan));
    for (const name of DIRECT_PACKAGES) {
      expect(packages, `${name} is a direct dependency and must remain repairable`).toContain(name);
    }
  }, 60000);

  it('should produce install actions that pass the real tool validator', async () => {
    const diagnostics = await diagnoseFixture(manifestOnlyFixture);
    const planner = createRepairPlanner();
    const plan = await planner.createPlan(diagnostics, planContext(manifestOnlyFixture.workspace));

    const actions = installActions(plan);
    expect(actions.length).toBeGreaterThan(0);

    // Regression guard: a remediation payload without `ecosystem` produced actions
    // that the installer rejects at execution time with
    // "Unsupported ecosystem: undefined".
    const tool = new InstallDependencyTool();
    for (const action of actions) {
      const validation = tool.validate(action);
      expect(validation.errors, `${action.description} must be executable: ${validation.errors.join('; ')}`).toEqual([]);
    }
  }, 60000);

  it('should produce valid, non-executable-without-approval install actions', async () => {
    const diagnostics = await diagnoseFixture(manifestOnlyFixture);
    const planner = createRepairPlanner();
    const plan = await planner.createPlan(diagnostics, planContext(manifestOnlyFixture.workspace));

    expect(plan.requiresApproval).toBe(true);
    for (const action of installActions(plan)) {
      expect(action.permissionLevel).toBe('project-modification');
      expect(action.parameters['ecosystem']).toBe('npm');
      expect(action.parameters['workspaceRoot']).toBe(manifestOnlyFixture.root);
    }
  }, 60000);
});

describe('yarn and pnpm lockfiles', () => {
  it('should not propose installs for yarn.lock transitive entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resolveit-yarn-regression-'));
    try {
      await writeJson(join(root, 'package.json'), {
        name: 'yarn-regression',
        version: '1.0.0',
        dependencies: { commander: '^12.0.0' },
      });
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, 'yarn.lock'),
        [
          '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
          '# yarn lockfile v1',
          '',
          'commander@^12.0.0:',
          '  version "12.0.0"',
          '  resolved "https://registry.yarnpkg.com/commander/-/commander-12.0.0.tgz"',
          '',
          'streamsearch@^1.1.0:',
          '  version "1.1.0"',
          '  resolved "https://registry.yarnpkg.com/streamsearch/-/streamsearch-1.1.0.tgz"',
          '',
          'zwitch@^2.0.0:',
          '  version "2.0.0"',
          '  resolved "https://registry.yarnpkg.com/zwitch/-/zwitch-2.0.0.tgz"',
          '',
        ].join('\n'),
        'utf-8'
      );

      const workspace = await scanWorkspace(root, { maxDepth: 10, maxFiles: 1000 });
      const requirements = await scanRequirements(root, { timeout: 20000 });
      const environment = await scanEnvironment({ timeout: 20000 });
      const diagnostics = await createDiagnosticEngine().runDiagnosticsWithContext(
        workspace,
        environment,
        requirements
      );

      const names = installedPackages(diagnostics);
      expect(names).toContain('streamsearch');
      expect(names).toContain('zwitch');

      for (const name of ['streamsearch', 'zwitch']) {
        const diagnostic = diagnostics.find(
          (entry) => entry.requirement?.name === name && entry.category === 'dependency'
        );
        const installs = (diagnostic?.remediationCandidates ?? []).filter(
          (candidate) => candidate.type === 'install-dependency'
        );
        expect(installs, `${name} from yarn.lock must not offer an install`).toEqual([]);
      }

      const plan = await createRepairPlanner().createPlan(diagnostics, planContext(workspace));
      const packages = installedPackagesOf(installActions(plan));
      expect(packages).not.toContain('streamsearch');
      expect(packages).not.toContain('zwitch');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90000);
});
