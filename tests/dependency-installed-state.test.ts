import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  analyzeObservation,
  createAIPlanner,
  createDeterministicRepairPlanner,
  inspectNpmPackageInstallState,
  isBlockingDiagnostic,
  observeWorkspace,
  validateAIPlan,
  buildAIPlanningContext,
} from '../src/index.js';
import { InstallDependencyTool } from '../src/repair/tools/install-dependency.js';
import type { AIProvider } from '../src/index.js';

const EXPRESS_MANIFEST = {
  name: 'resolveit-test-missing',
  version: '1.0.0',
  private: true,
  dependencies: { express: '^5.1.0' },
};

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'resolveit-depstate-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = join(root, ...relative.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf-8');
  }
  return root;
}

async function installTree(root: string, name: string, version: string): Promise<void> {
  const dir = join(root, 'node_modules', ...name.split('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version }), 'utf-8');
}

function stubProvider(generatePlan: AIProvider['generatePlan']): AIProvider {
  return {
    type: 'external',
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

describe('project-local dependency installed state', () => {
  it('1. declares express but has no node_modules -> missing dependency diagnostic (blocking)', async () => {
    const root = await fixture({ 'package.json': JSON.stringify(EXPRESS_MANIFEST) });
    try {
      const observation = await observeWorkspace(root);
      expect(observation.requirements.flatMap((parsed) => parsed.requirements).map((req) => req.name)).toContain(
        'express'
      );
      const analysis = await analyzeObservation(observation);
      const missing = analysis.diagnostics.filter((diag) => diag.code === 'DEPENDENCY_PACKAGE_MISSING');
      expect(missing).toHaveLength(1);
      expect(missing[0]?.severity).toBe('error');
      expect(isBlockingDiagnostic(missing[0] as never)).toBe(true);
      expect(missing[0]?.message).toContain('express');
      expect(missing[0]?.message).toContain('not currently installed');
      expect(analysis.blockingDiagnostics.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);

  it('2. installed express satisfies the constraint -> no missing/mismatch diagnostic', async () => {
    const root = await fixture({ 'package.json': JSON.stringify(EXPRESS_MANIFEST) });
    try {
      await installTree(root, 'express', '5.1.0');
      const analysis = await analyzeObservation(await observeWorkspace(root));
      const problems = analysis.diagnostics.filter(
        (diag) => diag.code === 'DEPENDENCY_PACKAGE_MISSING' || diag.code === 'DEPENDENCY_PACKAGE_VERSION_MISMATCH'
      );
      expect(problems).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);

  it('3. installed express 4.x against ^5.1.0 -> version mismatch diagnostic (blocking)', async () => {
    const root = await fixture({ 'package.json': JSON.stringify(EXPRESS_MANIFEST) });
    try {
      await installTree(root, 'express', '4.21.2');
      const analysis = await analyzeObservation(await observeWorkspace(root));
      const mismatched = analysis.diagnostics.filter(
        (diag) => diag.code === 'DEPENDENCY_PACKAGE_VERSION_MISMATCH'
      );
      expect(mismatched).toHaveLength(1);
      expect(mismatched[0]?.severity).toBe('error');
      expect(isBlockingDiagnostic(mismatched[0] as never)).toBe(true);
      expect(mismatched[0]?.message).toContain('4.21.2');
      expect(mismatched[0]?.evidence.some((item) => item.actual === '4.21.2')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);

  it('4. missing-dependency evidence reaches the AI planner context', async () => {
    const root = await fixture({ 'package.json': JSON.stringify(EXPRESS_MANIFEST) });
    try {
      const observation = await observeWorkspace(root);
      const analysis = await analyzeObservation(observation);
      const context = buildAIPlanningContext({ observation, analysis, workspaceRoot: root });
      const entry = context.diagnostics.find((diag) => diag.code === 'DEPENDENCY_PACKAGE_MISSING');
      expect(entry).toBeDefined();
      expect(entry?.expected).toBe('^5.1.0');
      expect(entry?.actual).toBe('NOT FOUND');
      expect(entry?.category).toBe('dependency');
      expect(context.availableTools.some((tool) => tool.name === 'install-dependency')).toBe(true);
      expect(context.requirements.some((req) => req.name === 'express')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);

  it('5. AI-proposed InstallDependencyTool action validates against the existing tool', async () => {
    const root = await fixture({ 'package.json': JSON.stringify(EXPRESS_MANIFEST) });
    try {
      const observation = await observeWorkspace(root);
      const analysis = await analyzeObservation(observation);
      const provider = stubProvider(() =>
        Promise.resolve({
          summary: 'Install the missing express dependency with npm',
          actions: [
            {
              type: 'install-dependency',
              parameters: { ecosystem: 'npm', package: 'express', version: '^5.1.0' },
              rationale: 'Project declares express ^5.1.0 but node_modules/express is absent',
            },
          ],
        })
      );
      const plan = createAIPlanner(provider);
      const result = await plan({
        analysis,
        workspaceRoot: root,
        attemptedFingerprints: new Set<string>(),
        previousAttempts: [],
      });
      expect(result.aiUsed).toBe(true);
      expect(result.plan.actions).toHaveLength(1);
      expect(result.plan.actions[0]?.type).toBe('install-dependency');
      expect(result.plan.actions[0]?.parameters).toMatchObject({
        ecosystem: 'npm',
        package: 'express',
        version: '^5.1.0',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);

  it('6. AI repair proposal passes validation and permission checks', async () => {
    const root = await fixture({ 'package.json': JSON.stringify(EXPRESS_MANIFEST) });
    try {
      const { valid, rejections } = validateAIPlan(
        [
          {
            type: 'install-dependency',
            parameters: { ecosystem: 'npm', package: 'express', version: '^5.1.0' },
            rationale: 'missing project dependency',
          },
        ],
        root
      );
      expect(rejections).toHaveLength(0);
      expect(valid).toHaveLength(1);
      const action = valid[0]?.action as never as { permissionLevel: string; riskLevel: string };
      expect(action.permissionLevel).toBe('project-modification');
      expect(action.riskLevel).toBe('project-modification');
      expect(new InstallDependencyTool().validate(valid[0]?.action as never)).toMatchObject({ valid: true });
      // Arbitrary shell commands remain rejected.
      const hostile = validateAIPlan(
        [{ type: 'run-script', parameters: { command: 'rm -rf /', script: 'evil' } }],
        root
      );
      expect(hostile.valid).toHaveLength(0);
      expect(hostile.rejections.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);

  it('7. materializing the install clears verification (before -> missing, after -> satisfied)', async () => {
    const root = await fixture({ 'package.json': JSON.stringify(EXPRESS_MANIFEST) });
    try {
      const before = await analyzeObservation(await observeWorkspace(root));
      expect(before.blockingDiagnostics.some((diag) => diag.code === 'DEPENDENCY_PACKAGE_MISSING')).toBe(true);

      const tool = new InstallDependencyTool();
      const dry = await tool.execute(
        {
          id: 'a1',
          type: 'install-dependency',
          permissionLevel: 'project-modification',
          description: 'Install express ^5.1.0',
          target: {},
          parameters: { ecosystem: 'npm', package: 'express', version: '^5.1.0', workspaceRoot: root },
          riskLevel: 'project-modification',
          prerequisites: [],
        },
        true
      );
      expect(dry.success).toBe(true);
      expect(String(dry.output)).toContain('npm install');

      await installTree(root, 'express', '5.1.0');
      const after = await analyzeObservation(await observeWorkspace(root));
      const beforeKeys = new Set(before.blockingDiagnostics.map((diag) => diag.code));
      const afterKeys = new Set(after.blockingDiagnostics.map((diag) => diag.code));
      expect(beforeKeys.has('DEPENDENCY_PACKAGE_MISSING')).toBe(true);
      expect(afterKeys.has('DEPENDENCY_PACKAGE_MISSING')).toBe(false);
      expect(afterKeys.has('DEPENDENCY_PACKAGE_VERSION_MISMATCH')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);

  it('8. AI unavailable -> deterministic diagnostic still reports missing with an install action', async () => {
    const root = await fixture({ 'package.json': JSON.stringify(EXPRESS_MANIFEST) });
    try {
      const observation = await observeWorkspace(root);
      const analysis = await analyzeObservation(observation);
      expect(analysis.blockingDiagnostics.some((diag) => diag.code === 'DEPENDENCY_PACKAGE_MISSING')).toBe(true);

      const planner = createDeterministicRepairPlanner();
      const result = await planner.createPlan({ analysis, workspaceRoot: root, attemptedFingerprints: new Set() });
      const install = result.plan.actions.find((action) => action.type === 'install-dependency');
      expect(install).toBeDefined();
      expect(install?.parameters).toMatchObject({ ecosystem: 'npm', package: 'express', version: '^5.1.0' });

      // A failing AI provider falls back to the same deterministic repair.
      const failing = stubProvider(() => Promise.reject(new Error('provider down')));
      const fallbacks: string[] = [];
      const aiPlan = createAIPlanner(failing, {
        onFallback: (reason) => fallbacks.push(reason),
      });
      const fallback = await aiPlan({
        analysis,
        workspaceRoot: root,
        attemptedFingerprints: new Set<string>(),
        previousAttempts: [],
      });
      expect(fallback.aiUsed).toBe(false);
      expect(fallbacks).toContain('ai-error');
      expect(fallback.plan.actions.some((action) => action.type === 'install-dependency')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);

  it('9. healthy project (satisfied) -> deterministic planner fabricates no repair action', async () => {
    const root = await fixture({ 'package.json': JSON.stringify(EXPRESS_MANIFEST) });
    try {
      await installTree(root, 'express', '5.1.0');
      const analysis = await analyzeObservation(await observeWorkspace(root));
      expect(analysis.blockingDiagnostics).toHaveLength(0);
      const planner = createDeterministicRepairPlanner();
      const result = await planner.createPlan({ analysis, workspaceRoot: root, attemptedFingerprints: new Set() });
      expect(result.plan.actions).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);

  it('10. lockfile alone and foreign trees never mark a project dependency satisfied', async () => {
    const root = await fixture({
      'package.json': JSON.stringify(EXPRESS_MANIFEST),
      'package-lock.json': JSON.stringify({
        name: 'resolveit-test-missing',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: { 'node_modules/express': { version: '5.1.0' } },
      }),
    });
    const elsewhere = await fixture({});
    try {
      await installTree(elsewhere, 'express', '5.1.0');
      // A populated tree in another directory proves nothing about this project.
      expect((await inspectNpmPackageInstallState(root, 'express')).status).toBe('missing');
      // A lockfile entry without the installed tree still reports missing.
      const analysis = await analyzeObservation(await observeWorkspace(root));
      expect(
        analysis.diagnostics.some((diag) => diag.code === 'DEPENDENCY_PACKAGE_MISSING')
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  }, 120000);

  it('inspector rejects unsafe names and stays read-only inside the project', async () => {
    const root = await fixture({ 'package.json': JSON.stringify(EXPRESS_MANIFEST) });
    try {
      for (const unsafe of ['../evil', '/abs', '', 'a/b/c', '@scope', 'pkg;rm']) {
        expect((await inspectNpmPackageInstallState(root, unsafe)).status).toBe('missing');
      }
      expect((await inspectNpmPackageInstallState(root, '@scope/express')).status).toBe('missing');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);

  it('development dependencies report issues without blocking, optional stays informational', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({
        name: 'x',
        version: '1.0.0',
        devDependencies: { vitest: '^3.0.0' },
        optionalDependencies: { fsevents: '^2.3.0' },
      }),
    });
    try {
      const analysis = await analyzeObservation(await observeWorkspace(root));
      const dev = analysis.diagnostics.find((diag) => diag.requirement?.name === 'vitest');
      expect(dev?.severity).toBe('warning');
      expect(dev?.code).toBe('DEPENDENCY_PACKAGE_MISSING');
      expect(isBlockingDiagnostic(dev as never)).toBe(false);
      const optional = analysis.diagnostics.find((diag) => diag.requirement?.name === 'fsevents');
      expect(optional?.severity).toBe('info');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);
});
