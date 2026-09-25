import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdtemp } from 'fs/promises';
import { checkWorkspaceContainment, verifyNoSymlinkEscape } from '../src/safety/paths.js';
import { sanitizeParameters, redactSecrets, isEnvFile, isSensitiveKey } from '../src/safety/secrets.js';
import { SECURITY_LIMITS } from '../src/safety/limits.js';
import { createId } from '../src/safety/ids.js';
import { CreateFileTool } from '../src/repair/tools/create-file.js';
import { ModifyFileTool } from '../src/repair/tools/modify-file.js';
import { InstallDependencyTool } from '../src/repair/tools/install-dependency.js';
import { CreatePythonVenvTool } from '../src/repair/tools/create-python-venv.js';
import { createRepairExecutor, createAuditLogger } from '../src/repair/index.js';
import { createSafeCommandRunner, REPAIR_EXECUTABLE_ALLOWLIST } from '../src/environment/command-runner.js';
import { validateAIAction, validateAIPlan } from '../src/ai/validation.js';
import { parseAIPlanningResponse } from '../src/ai/response.js';
import { buildAIPlanningContext } from '../src/ai/context.js';
import { buildPlanningPrompt } from '../src/ai/prompt.js';
import { createAIPlanner } from '../src/agent/ai-planner.js';
import { dockerSecurityDiagnosticRule } from '../src/diagnostics/rules/docker-security.js';
import type { DiagnosticContext } from '../src/core/interfaces.js';
import type { RepairAction, RepairActionType, RiskLevel } from '../src/core/models.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECURITY_FIXTURES = join(HERE, 'fixtures', 'security');

function makeAction(overrides: Partial<RepairAction> & { type: RepairActionType }): RepairAction {
  return {
    id: 'action-test-1',
    permissionLevel: 'project-modification',
    description: 'test action',
    target: {},
    parameters: {},
    riskLevel: 'project-modification',
    prerequisites: [],
    ...overrides,
  };
}

describe('Phase 11: filesystem boundary', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'resolveit-sec-'));
    await fs.mkdir(join(root, 'ws'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects parent traversal', () => {
    const ws = join(root, 'ws');
    expect(checkWorkspaceContainment(ws, '../../outside.txt').ok).toBe(false);
    expect(checkWorkspaceContainment(ws, 'a/../../outside.txt').ok).toBe(false);
  });

  it('rejects absolute paths outside the workspace', () => {
    const ws = join(root, 'ws');
    expect(checkWorkspaceContainment(ws, '/etc/passwd').ok).toBe(false);
    expect(checkWorkspaceContainment(ws, join(root, 'sibling', 'x.txt')).ok).toBe(false);
  });

  it('rejects sibling-prefix confusion', () => {
    const ws = join(root, 'ws');
    expect(checkWorkspaceContainment(ws, join(root, 'ws-evil', 'x.txt')).ok).toBe(false);
    expect(checkWorkspaceContainment(ws, '../ws-evil/x.txt').ok).toBe(false);
  });

  it('rejects Windows drive and UNC paths escaping the workspace', () => {
    const ws = join(root, 'ws');
    expect(checkWorkspaceContainment(ws, 'C:\\Windows\\Temp\\evil.txt').ok).toBe(false);
    expect(checkWorkspaceContainment(ws, '\\\\server\\share\\evil.txt').ok).toBe(false);
    expect(checkWorkspaceContainment(ws, '//server/share/evil.txt').ok).toBe(false);
  });

  it('rejects encoded traversal attempts', () => {
    const ws = join(root, 'ws');
    expect(checkWorkspaceContainment(ws, '%2e%2e%2foutside.txt').ok).toBe(false);
    expect(checkWorkspaceContainment(ws, '%252e%252e%252foutside.txt').ok).toBe(false);
    expect(checkWorkspaceContainment(ws, '..%5coutside.txt').ok).toBe(false);
  });

  it('rejects NUL bytes and control characters', () => {
    const ws = join(root, 'ws');
    expect(checkWorkspaceContainment(ws, 'a\0b.txt').ok).toBe(false);
    expect(checkWorkspaceContainment(ws, 'a\x01b.txt').ok).toBe(false);
  });

  it('allows contained relative and absolute paths', () => {
    const ws = join(root, 'ws');
    expect(checkWorkspaceContainment(ws, 'sub/dir/file.txt').ok).toBe(true);
    expect(checkWorkspaceContainment(ws, join(ws, 'file.txt')).ok).toBe(true);
  });

  it('fails closed on symlink escape', async () => {
    const ws = join(root, 'ws');
    const outside = join(root, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(join(outside, 'secret.txt'), 'x', 'utf-8');
    const link = join(ws, 'link');
    try {
      await fs.symlink(outside, link, 'dir');
    } catch {
      return;
    }
    const result = await verifyNoSymlinkEscape(ws, resolve(ws, 'link', 'evil.txt'));
    expect(result.ok).toBe(false);
  });

  it('refuses file creation through a symlink escape', async () => {
    const ws = join(root, 'ws');
    const outside = join(root, 'outside');
    await fs.mkdir(outside, { recursive: true });
    const link = join(ws, 'linkdir');
    try {
      await fs.symlink(outside, link, 'dir');
    } catch {
      return;
    }
    const tool = new CreateFileTool();
    const action = makeAction({
      type: 'create-environment',
      parameters: { path: 'linkdir/evil.txt', content: 'x', workspaceRoot: ws },
      target: { filePath: ws },
    });
    const result = await tool.execute(action, false);
    expect(result.success).toBe(false);
    const entries = await fs.readdir(outside);
    expect(entries).not.toContain('evil.txt');
  });
});

describe('Phase 11: repair-tool input validation', () => {
  it('rejects traversal and absolute install-adjacent file paths', () => {
    const tool = new CreateFileTool();
    for (const bad of ['../../outside.txt', '/etc/passwd', 'C:\\Windows\\evil.txt', '\\\\s\\share\\x.txt', '%2e%2e/x.txt']) {
      const action = makeAction({
        type: 'create-environment',
        parameters: { path: bad, content: 'x', workspaceRoot: '/tmp/ws' },
        target: { filePath: '/tmp/ws' },
      });
      expect(tool.validate(action).valid, bad).toBe(false);
    }
  });

  it('rejects malicious package names', () => {
    const tool = new InstallDependencyTool();
    for (const bad of [
      'package;evil',
      'package && evil',
      'package | evil',
      '$(evil)',
      '`evil`',
      '--save-dev',
      '-e evil',
      '',
      '   ',
      'pkg name',
      '../evil',
      'a'.repeat(SECURITY_LIMITS.maxPackageNameLength + 1),
    ]) {
      const action = makeAction({
        type: 'install-dependency',
        parameters: { ecosystem: 'npm', package: bad, workspaceRoot: '/tmp/ws' },
      });
      expect(tool.validate(action).valid, bad).toBe(false);
    }
  });

  it('rejects malicious versions and arbitrary executables', () => {
    const tool = new InstallDependencyTool();
    for (const badVersion of ['1.0; rm -rf /', '$(evil)', '`evil`', '1.0|evil', 'v1 && evil']) {
      const action = makeAction({
        type: 'install-dependency',
        parameters: { ecosystem: 'npm', package: 'lodash', version: badVersion, workspaceRoot: '/tmp/ws' },
      });
      expect(tool.validate(action).valid, badVersion).toBe(false);
    }
    const venv = new CreatePythonVenvTool();
    for (const badExe of ['/bin/evil', 'python;evil', 'python | evil', '$(python)', 'cmd.exe /c evil']) {
      const action = makeAction({
        type: 'create-environment',
        parameters: { path: 'venv', pythonExecutable: badExe, workspaceRoot: '/tmp/ws' },
        target: { filePath: '/tmp/ws' },
      });
      expect(venv.validate(action).valid, badExe).toBe(false);
    }
  });

  it('rejects oversized content and enforces dry-run side-effect freedom', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'resolveit-dry-'));
    try {
      const tool = new CreateFileTool();
      const huge = makeAction({
        type: 'create-environment',
        parameters: { path: 'big.txt', content: 'x'.repeat(SECURITY_LIMITS.maxRepairContentBytes + 1), workspaceRoot: ws },
        target: { filePath: ws },
      });
      expect(tool.validate(huge).valid).toBe(false);

      const dry = makeAction({
        type: 'create-environment',
        parameters: { path: 'new.txt', content: 'hello', workspaceRoot: ws },
        target: { filePath: ws },
      });
      const result = await tool.execute(dry, true);
      expect(result.success).toBe(true);
      await expect(fs.stat(join(ws, 'new.txt'))).rejects.toThrow();
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it('modify-file refuses oversized targets', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'resolveit-mod-'));
    try {
      const tool = new ModifyFileTool();
      const action = makeAction({
        type: 'modify-configuration',
        parameters: { path: 'f.txt', find: 'a', replace: 'x'.repeat(SECURITY_LIMITS.maxFindReplaceBytes + 1), workspaceRoot: ws },
        target: { filePath: ws },
      });
      expect(tool.validate(action).valid).toBe(false);
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
});

describe('Phase 11: safe command runner policy', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'resolveit-runner-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects executables outside the allowlist', async () => {
    const runner = createSafeCommandRunner({ allowedExecutables: REPAIR_EXECUTABLE_ALLOWLIST, allowedRoot: root });
    const result = await runner.run('rm', ['-rf', '/'], { cwd: root });
    expect(result.exitCode).toBe(-1);
    expect(result.error).toMatch(/allowlist/);
  });

  it('rejects executable paths and shell metacharacter args', async () => {
    const runner = createSafeCommandRunner({ allowedExecutables: REPAIR_EXECUTABLE_ALLOWLIST, allowedRoot: root });
    for (const bad of ['/bin/npm', '..\\npm', 'npm;evil']) {
      const result = await runner.run(bad, [], { cwd: root });
      expect(result.exitCode).toBe(-1);
    }
    for (const badArg of ['lodash;evil', '$(evil)', '`evil`', 'a|b', 'a&b']) {
      const result = await runner.run('npm', [badArg], { cwd: root });
      expect(result.exitCode).toBe(-1);
      expect(result.error).toMatch(/metacharacters/);
    }
  });

  it('rejects working directories outside the allowed root', async () => {
    const runner = createSafeCommandRunner({ allowedExecutables: REPAIR_EXECUTABLE_ALLOWLIST, allowedRoot: root });
    const result = await runner.run('npm', ['--version'], { cwd: join(root, '..') });
    expect(result.exitCode).toBe(-1);
    expect(result.error).toMatch(/Working directory/);
  });
});

describe('Phase 11: AI action security', () => {
  const ws = '/tmp/ws';

  it('rejects unknown tools, unknown params, command fields, and escalation', () => {
    expect(validateAIAction({ type: 'run-shell', parameters: { command: 'x' } }, ws, 'a1')).toHaveProperty('rejection');
    expect(validateAIAction({ type: 'execute', parameters: { shell: true } }, ws, 'a1')).toHaveProperty('rejection');
    expect(validateAIAction({ type: 'spawn', parameters: {} }, ws, 'a1')).toHaveProperty('rejection');
    expect(
      validateAIAction({ type: 'create-file', parameters: { path: 'x.txt', content: 'y', bogus: 1 } }, ws, 'a1')
    ).toHaveProperty('rejection');
    expect(
      validateAIAction({ type: 'create-file', parameters: { path: 'x.txt', content: 'y', permissionLevel: 'read-only' } }, ws, 'a1')
    ).toHaveProperty('rejection');
    expect(
      validateAIAction({ type: 'create-file', parameters: { path: 'x.txt', content: 'y', shell: 'x' } }, ws, 'a1')
    ).toHaveProperty('rejection');
  });

  it('rejects traversal and absolute paths from AI', () => {
    for (const bad of ['../../evil.txt', '/etc/passwd', 'C:\\Windows\\x.txt', '\\\\s\\share\\x.txt']) {
      const outcome = validateAIAction({ type: 'create-file', parameters: { path: bad, content: 'x' } }, ws, 'a1');
      expect(outcome, bad).toHaveProperty('rejection');
    }
  });

  it('rejects oversized responses and excessive action counts', () => {
    expect(() => parseAIPlanningResponse('x'.repeat(SECURITY_LIMITS.maxAiResponseBytes + 1))).toThrow(/exceeds maximum size/);
    const many = Array.from({ length: 40 }, (_, i) => ({
      type: 'create-file',
      parameters: { path: `f${i}.txt`, content: 'x' },
    }));
    const result = validateAIPlan(many, ws);
    expect(result.valid.length).toBeLessThanOrEqual(SECURITY_LIMITS.maxAiActions);
    expect(result.rejections.length).toBeGreaterThan(0);
  });

  it('rejects deeply nested and recursive payloads', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 8; i += 1) {
      const next: Record<string, unknown> = {};
      cursor['n'] = next;
      cursor = next;
    }
    expect(validateAIPlan([{ type: 'create-file', parameters: { path: 'x.txt', content: 'y', nested: deep } }], ws).valid).toHaveLength(0);
    const circular: Record<string, unknown> = { path: 'x.txt', content: 'y' };
    circular['self'] = circular;
    expect(validateAIPlan([{ type: 'create-file', parameters: circular }], ws).valid).toHaveLength(0);
  });

  it('treats prompt-injection fixtures as rejected data', async () => {
    const base = SECURITY_FIXTURES;
    for (const file of [
      'malicious-ai-output/command-injection.json',
      'malicious-ai-output/privilege-escalation.json',
      'prompt-injection/readme-instructions.json',
    ]) {
      const raw = await fs.readFile(join(base, file), 'utf-8');
      const parsed = parseAIPlanningResponse(raw);
      const result = validateAIPlan(
        parsed.actions.map((action) => ({ type: action.type, parameters: action.parameters })),
        ws
      );
      expect(result.valid, file).toHaveLength(0);
      expect(result.rejections.length).toBeGreaterThan(0);
    }
  });

  it('never lets AI assign permission levels', () => {
    const outcome = validateAIAction(
      { type: 'install-dependency', parameters: { ecosystem: 'npm', package: 'lodash' } },
      ws,
      'a1'
    );
    expect(outcome).not.toHaveProperty('rejection');
    if (!('rejection' in outcome)) {
      expect(outcome.action.permissionLevel).toBe('project-modification');
      expect(outcome.action.parameters['workspaceRoot']).toBe(ws);
    }
  });

  it('falls back to deterministic planning when AI output is fully hostile', async () => {
    const hostile = {
      type: 'external' as const,
      name: 'hostile',
      version: '0',
      isAvailable: () => Promise.resolve(true),
      diagnose: () => Promise.reject(new Error('unused')),
      planRepair: () => Promise.reject(new Error('unused')),
      generatePlan: () =>
        Promise.resolve({
          summary: 'pwned',
          actions: [{ type: 'run-shell', parameters: { command: 'rm -rf /' } }],
        }),
    };
    const planner = createAIPlanner(hostile as never);
    const analysis = {
      blockingDiagnostics: [],
      diagnostics: [],
      observation: {
        workspace: { projects: [], languages: [], rootPath: ws },
        environment: { runtimes: [], devTools: [], containers: { docker: { available: false }, dockerRunning: false }, environmentVariables: {} },
        requirements: [],
        timestamp: new Date(),
      },
    };
    const plan = await planner({
      analysis: analysis as never,
      workspaceRoot: ws,
      attemptedFingerprints: new Set<string>(),
    });
    expect(plan.aiUsed).toBe(false);
    expect(plan.plan.actions.every((action) => action.type !== 'run-shell')).toBe(true);
  });

  it('keeps project content as untrusted evidence in prompts', () => {
    const context = buildAIPlanningContext({
      observation: {
        workspace: { projects: [], languages: [], rootPath: ws },
        environment: { runtimes: [], devTools: [], containers: { docker: {}, dockerRunning: false } },
        requirements: [],
        timestamp: new Date(),
      } as never,
      analysis: { blockingDiagnostics: [], diagnostics: [], observation: undefined } as never,
      workspaceRoot: ws,
    });
    const prompt = buildPlanningPrompt(context);
    expect(prompt.system).toMatch(/untrusted data/);
  });
});

describe('Phase 11: secrets', () => {
  it('redacts sensitive keys including nested objects', () => {
    expect(isSensitiveKey('api_key')).toBe(true);
    expect(isSensitiveKey('authorization')).toBe(true);
    expect(isSensitiveKey('AccessToken')).toBe(true);
    expect(isSensitiveKey('path')).toBe(false);
    const result = sanitizeParameters({ path: 'ok', token: 'abc', nested: { password: 'x', safe: 'y' } });
    expect(result['token']).toBe('[REDACTED]');
    expect((result['nested'] as Record<string, unknown>)['password']).toBe('[REDACTED]');
  });

  it('redacts bearer tokens, api keys, and private keys from text', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop')).toContain('Bearer [REDACTED]');
    expect(redactSecrets('api_key=AKIAIOSFODNN7EXAMPLE')).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(
      redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----')
    ).toContain('[REDACTED_PRIVATE_KEY]');
  });

  it('never treats .env files as ordinary evidence', () => {
    expect(isEnvFile('.env')).toBe(true);
    expect(isEnvFile('sub/.env.local')).toBe(true);
    expect(isEnvFile('sub/.env.production')).toBe(true);
    expect(isEnvFile('package.json')).toBe(false);
    expect(isEnvFile('.env.example')).toBe(false);
  });

  it('redacts secrets from AI context evidence', () => {
    const observation = {
      workspace: { projects: [], languages: [], rootPath: '/tmp/ws' },
      environment: { runtimes: [], devTools: [], containers: { docker: {}, dockerRunning: false } },
      requirements: [],
      timestamp: new Date(),
    } as never;
    const analysis = {
      blockingDiagnostics: [
        {
          code: 'X',
          category: 'configuration',
          severity: 'error',
          title: 'bad config',
          message: 'found api_key=hunter2-secret-value here',
          evidence: [{ source: 'project', description: 'leak', actual: 'api_key=hunter2-secret-value' }],
          affectedFiles: [],
        },
      ],
      diagnostics: [],
      observation,
    } as never;
    const context = buildAIPlanningContext({ observation, analysis, workspaceRoot: '/tmp/ws' });
    expect(JSON.stringify(context.diagnostics)).not.toContain('hunter2-secret-value');
  });
});

describe('Phase 11: Docker security diagnostics', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'resolveit-docker-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function diagnoseFixture(fixtureDir: string) {
    const names = await fs.readdir(fixtureDir);
    for (const name of names) {
      await fs.copyFile(join(fixtureDir, name), join(dir, name));
    }
    const context = {
      workspace: {
        rootPath: dir,
        allFiles: names.map((name) => ({ relativePath: name })),
      },
      environment: {},
      requirements: [],
    } as unknown as DiagnosticContext;
    return dockerSecurityDiagnosticRule.diagnose(context);
  }

  const fixture = (...parts: string[]) => join(SECURITY_FIXTURES, ...parts);

  it('flags privileged mode as critical', async () => {
    const findings = await diagnoseFixture(fixture('docker-privileged'));
    const match = findings.filter((d) => d.code === 'CONTAINER_PRIVILEGED_MODE');
    expect(match).toHaveLength(1);
    expect(match[0]?.severity).toBe('critical');
  });

  it('flags Docker socket mounts as critical', async () => {
    const findings = await diagnoseFixture(fixture('docker-socket'));
    const match = findings.filter((d) => d.code === 'CONTAINER_DOCKER_SOCKET');
    expect(match).toHaveLength(1);
    expect(match[0]?.severity).toBe('critical');
  });

  it('flags host filesystem mounts', async () => {
    const findings = await diagnoseFixture(fixture('docker-host-mount'));
    const match = findings.filter((d) => d.code === 'CONTAINER_HOST_MOUNT');
    expect(match.length).toBeGreaterThanOrEqual(1);
    expect(match[0]?.severity).toBe('error');
  });

  it('flags host networking and host PID/IPC', async () => {
    const findings = await diagnoseFixture(fixture('docker-host-network'));
    expect(findings.some((d) => d.code === 'CONTAINER_HOST_NETWORK')).toBe(true);
    expect(findings.some((d) => d.code === 'CONTAINER_HOST_PID_IPC')).toBe(true);
  });

  it('flags dangerous capabilities', async () => {
    const findings = await diagnoseFixture(fixture('docker-capabilities'));
    const caps = findings.filter((d) => d.code === 'CONTAINER_DANGEROUS_CAPABILITY');
    expect(caps.length).toBeGreaterThanOrEqual(2);
  });

  it('flags unpinned images without calling them malicious', async () => {
    const findings = await diagnoseFixture(fixture('docker-unpinned'));
    const unpinned = findings.filter((d) => d.code === 'CONTAINER_UNPINNED_IMAGE');
    expect(unpinned.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(unpinned).toLowerCase()).not.toContain('malicious');
    expect(findings.some((d) => d.code === 'CONTAINER_BROAD_BUILD_CONTEXT')).toBe(true);
  });

  it('produces no findings for pinned, narrow configuration', async () => {
    const findings = await diagnoseFixture(fixture('docker-safe'));
    expect(findings).toHaveLength(0);
  });

  it('keeps findings diagnostic-only with evidence and remediation', async () => {
    const findings = await diagnoseFixture(fixture('docker-privileged'));
    for (const item of findings) {
      expect(item.category).toBe('container');
      expect(item.evidence.length).toBeGreaterThan(0);
      expect(item.affectedFiles?.length).toBeGreaterThan(0);
      expect(item.remediationCandidates ?? []).toHaveLength(0);
      expect(String((item.metadata as Record<string, unknown>)['remediation'] ?? '')).not.toBe('');
    }
  });
});

describe('Phase 11: audit logging and correlation', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'resolveit-audit-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('records approval, execution, and verification-correlated entries without secrets', async () => {
    const executor = createRepairExecutor(root);
    const plan = {
      id: 'plan-1',
      name: 'p',
      description: 'p',
      actions: [
        makeAction({
          id: 'action-secret-1',
          type: 'create-environment' as RepairActionType,
          parameters: { path: 'hello.txt', content: 'hi', apiKey: 'super-secret-value', workspaceRoot: root },
          target: { filePath: root },
          affectedFiles: ['hello.txt'],
        }),
      ],
      requiresApproval: true,
    };
    const result = await executor.executePlan(plan, {
      dryRun: false,
      workspaceRoot: root,
      approvalCallback: () => Promise.resolve('allowed'),
      runId: 'run-correlation-1',
    });
    expect(result.success).toBe(true);

    const logger = createAuditLogger(root);
    const entries = await logger.query({ runId: 'run-correlation-1' });
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0]?.approvalState).toBe('allowed');
    expect(entries[entries.length - 1]?.executionResult).toBe('success');
    expect(entries.every((entry) => entry.runId === 'run-correlation-1')).toBe(true);
    expect(entries.every((entry) => entry.workspaceRoot === root)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('super-secret-value');

    const logDir = join(root, '.resolveit/audit');
    const files = await fs.readdir(logDir);
    const combined = (await Promise.all(files.map((f) => fs.readFile(join(logDir, f), 'utf-8')))).join('\n');
    expect(combined).not.toContain('super-secret-value');
  });

  it('records denials and makes no modification', async () => {
    const executor = createRepairExecutor(root);
    const plan = {
      id: 'plan-1',
      name: 'p',
      description: 'p',
      actions: [
        makeAction({
          id: 'action-denied-1',
          type: 'create-environment' as RepairActionType,
          parameters: { path: 'nope.txt', content: 'x', workspaceRoot: root },
          target: { filePath: root },
          affectedFiles: ['nope.txt'],
        }),
      ],
      requiresApproval: true,
    };
    const result = await executor.executePlan(plan, {
      dryRun: false,
      workspaceRoot: root,
      approvalCallback: () => Promise.resolve('denied'),
    });
    expect(result.success).toBe(false);
    await expect(fs.stat(join(root, 'nope.txt'))).rejects.toThrow();
    const entries = await createAuditLogger(root).query({ actionId: 'action-denied-1' });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]?.executionResult).toBe('failure');
  });

  it('queries deterministically with filters, limits, and malformed-record tolerance', async () => {
    const logger = createAuditLogger(root);
    await logger.log({
      id: 'audit-b', timestamp: new Date('2026-03-02T00:00:00Z'), actionId: 'a2',
      actionType: 'create-environment', permissionLevel: 'project-modification' as RiskLevel,
      approvalState: 'allowed', target: {}, parameters: {}, affectedFiles: [], executionResult: 'success',
    });
    await logger.log({
      id: 'audit-a', timestamp: new Date('2026-03-01T00:00:00Z'), actionId: 'a1',
      actionType: 'create-environment', permissionLevel: 'project-modification' as RiskLevel,
      approvalState: 'denied', target: {}, parameters: {}, affectedFiles: [], executionResult: 'failure',
    });
    const logDir = join(root, '.resolveit/audit');
    const files = await fs.readdir(logDir);
    await fs.appendFile(join(logDir, files[0] as string), 'not-json{{{\n', 'utf-8');

    const all = await logger.query({});
    expect(all.map((e) => e.id)).toEqual(['audit-a', 'audit-b']);
    expect(await logger.query({ actionId: 'a1' })).toHaveLength(1);
    expect(await logger.query({ limit: 1 })).toHaveLength(1);
    expect((await logger.query({ startTime: new Date('2026-03-02T00:00:00Z') })).map((e) => e.id)).toEqual(['audit-b']);
  });

  it('bounds large audit histories', async () => {
    const logger = createAuditLogger(root);
    for (let i = 0; i < SECURITY_LIMITS.maxAuditQueryResults + 50; i += 1) {
      await logger.log({
        id: `audit-${i}`, timestamp: new Date(), actionId: `a${i}`,
        actionType: 'create-environment', permissionLevel: 'project-modification' as RiskLevel,
        approvalState: 'allowed', target: {}, parameters: {}, affectedFiles: [], executionResult: 'success',
      });
    }
    const entries = await logger.query({});
    expect(entries.length).toBe(SECURITY_LIMITS.maxAuditQueryResults);
  });

  it('generates collision-resistant identifiers', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createId('action')));
    expect(ids.size).toBe(200);
  });
});
