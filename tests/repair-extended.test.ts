import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import type { ChildProcess } from 'child_process';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'child_process';
import { CreateFileTool } from '../src/repair/tools/create-file.js';
import { ModifyFileTool } from '../src/repair/tools/modify-file.js';
import { InstallDependencyTool } from '../src/repair/tools/install-dependency.js';
import { CreatePythonVenvTool } from '../src/repair/tools/create-python-venv.js';
import {
  createRepairExecutor,
  createRepairPlanner,
  createSnapshotManager,
  createAuditLogger,
  sanitizeParameters,
} from '../src/repair/index.js';
import type { RepairAction, RepairActionType, RiskLevel } from '../src/core/models.js';

const mockSpawn = vi.mocked(spawn);

function fakeChildClose(code: number, stdout = '', stderr = ''): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
  return child as unknown as ChildProcess;
}

function fakeChildError(message: string): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => {
    child.emit('error', new Error(message));
  });
  return child as unknown as ChildProcess;
}

function fileAction(overrides: Partial<RepairAction> & { parameters: Record<string, unknown> }): RepairAction {
  return {
    id: 'action-1',
    type: 'create-environment',
    permissionLevel: 'project-modification',
    description: 'Test action',
    target: {},
    affectedFiles: [],
    reversible: true,
    riskLevel: 'project-modification',
    prerequisites: [],
    ...overrides,
  } as RepairAction;
}

const testWorkspace = join(tmpdir(), 'resolveit-extended-');

describe('repair extended coverage', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(testWorkspace);
    mockSpawn.mockReset();
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  describe('CreateFileTool path safety', () => {
    it('should reject an absolute path outside the workspace', async () => {
      const tool = new CreateFileTool();
      const outside = resolve(workspaceRoot, '..', 'outside.txt');
      const result = await tool.execute(
        fileAction({
          target: { filePath: workspaceRoot },
          parameters: { path: outside, content: 'bad' },
        }),
        false
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside workspace');
    });

    it('should fail safely when no workspace root is available', async () => {
      const tool = new CreateFileTool();
      const result = await tool.execute(
        fileAction({
          target: {},
          parameters: { path: 'test.txt', content: 'hello' },
        }),
        false
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing workspace root');
    });

    it('should respect an explicit parameters.workspaceRoot', async () => {
      const tool = new CreateFileTool();
      const result = await tool.execute(
        fileAction({
          target: {},
          parameters: { path: 'explicit.txt', content: 'ok', workspaceRoot },
        }),
        false
      );
      expect(result.success).toBe(true);
      const content = await fs.readFile(join(workspaceRoot, 'explicit.txt'), 'utf-8');
      expect(content).toBe('ok');
    });
  });

  describe('ModifyFileTool path safety', () => {
    it('should reject an absolute path outside the workspace', async () => {
      const tool = new ModifyFileTool();
      const outside = resolve(workspaceRoot, '..', 'outside.txt');
      const result = await tool.execute(
        fileAction({
          type: 'modify-configuration',
          target: { filePath: workspaceRoot },
          parameters: { path: outside, find: 'a', replace: 'b' },
        }),
        false
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside workspace');
    });

    it('should fail safely when no workspace root is available', async () => {
      const tool = new ModifyFileTool();
      const result = await tool.execute(
        fileAction({
          type: 'modify-configuration',
          target: {},
          parameters: { path: 'test.txt', find: 'a', replace: 'b' },
        }),
        false
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing workspace root');
    });

    it('should succeed in dry-run without an existing file and create nothing', async () => {
      const tool = new ModifyFileTool();
      const result = await tool.execute(
        fileAction({
          type: 'modify-configuration',
          target: { filePath: workspaceRoot },
          parameters: { path: 'ghost.txt', find: 'a', replace: 'b' },
        }),
        true
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('Would modify file: ghost.txt');
      const exists = await fs.access(join(workspaceRoot, 'ghost.txt')).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });
  });

  describe('InstallDependencyTool validation', () => {
    it.each([
      'axios; rm -rf /',
      '$(evil)',
      'foo|bar',
      'foo && bar',
      '--save-dev',
      '../evil',
      'foo bar',
    ])('should reject malicious package name %s', async (pkg) => {
      const tool = new InstallDependencyTool();
      const result = await tool.execute(
        fileAction({
          type: 'install-dependency',
          target: { filePath: workspaceRoot },
          parameters: { ecosystem: 'npm', package: pkg },
        }),
        true
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid package name|Missing or invalid package parameter/);
    });

    it.each(['1.0; rm -rf', '"evil"', '1.0\nmalicious'])('should reject malicious version %s', async (version) => {
      const tool = new InstallDependencyTool();
      const result = await tool.execute(
        fileAction({
          type: 'install-dependency',
          target: { filePath: workspaceRoot },
          parameters: { ecosystem: 'npm', package: 'axios', version },
        }),
        true
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid version');
    });

    it('should construct cargo and go commands internally', async () => {
      const tool = new InstallDependencyTool();
      const cargo = await tool.execute(
        fileAction({
          type: 'install-dependency',
          target: { filePath: workspaceRoot },
          parameters: { ecosystem: 'cargo', package: 'serde', version: '^1.0.0' },
        }),
        true
      );
      expect(cargo.success).toBe(true);
      expect(cargo.output).toContain('Would run: cargo add serde');

      const go = await tool.execute(
        fileAction({
          type: 'install-dependency',
          target: { filePath: workspaceRoot },
          parameters: { ecosystem: 'go', package: 'example.com/mod' },
        }),
        true
      );
      expect(go.success).toBe(true);
      expect(go.output).toContain('Would run: go get example.com/mod');
    });

    it('should never spawn a process in dry-run mode', async () => {
      const tool = new InstallDependencyTool();
      await tool.execute(
        fileAction({
          type: 'install-dependency',
          target: { filePath: workspaceRoot },
          parameters: { ecosystem: 'npm', package: 'axios' },
        }),
        true
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should report command failure without throwing', async () => {
      mockSpawn.mockImplementationOnce(() => fakeChildClose(1, '', 'npm ERR! boom'));
      const tool = new InstallDependencyTool();
      const result = await tool.execute(
        fileAction({
          type: 'install-dependency',
          target: { filePath: workspaceRoot },
          parameters: { ecosystem: 'npm', package: 'axios' },
        }),
        false
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('boom');
    });

    it('should report spawn errors without throwing', async () => {
      mockSpawn.mockImplementationOnce(() => fakeChildError('spawn npm ENOENT'));
      const tool = new InstallDependencyTool();
      const result = await tool.execute(
        fileAction({
          type: 'install-dependency',
          target: { filePath: workspaceRoot },
          parameters: { ecosystem: 'npm', package: 'axios' },
        }),
        false
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to execute command');
    });

    it('should report success output', async () => {
      mockSpawn.mockImplementationOnce(() => fakeChildClose(0, 'added 1 package'));
      const tool = new InstallDependencyTool();
      const result = await tool.execute(
        fileAction({
          type: 'install-dependency',
          target: { filePath: workspaceRoot },
          parameters: { ecosystem: 'npm', package: 'axios' },
        }),
        false
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('added 1 package');
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn.mock.calls[0]?.[0]).toBe('npm');
    });
  });

  describe('CreatePythonVenvTool validation', () => {
    it.each(['python; rm -rf', '/usr/bin/evil', 'node', 'bash -c evil'])(
      'should reject suspicious python executable %s',
      async (exe) => {
        const tool = new CreatePythonVenvTool();
        const result = await tool.execute(
          fileAction({
            target: { filePath: workspaceRoot },
            parameters: { path: '.venv', pythonExecutable: exe },
          }),
          true
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid Python executable');
      }
    );

    it.each(['python', 'python3', 'python3.11', 'py', 'python.exe'])(
      'should accept python executable %s in dry-run',
      async (exe) => {
        const tool = new CreatePythonVenvTool();
        const result = await tool.execute(
          fileAction({
            target: { filePath: workspaceRoot },
            parameters: { path: '.venv', pythonExecutable: exe },
          }),
          true
        );
        expect(result.success).toBe(true);
      }
    );

    it('should never spawn a process in dry-run mode', async () => {
      const tool = new CreatePythonVenvTool();
      await tool.execute(
        fileAction({
          target: { filePath: workspaceRoot },
          parameters: { path: '.venv' },
        }),
        true
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should report venv creation failure', async () => {
      mockSpawn.mockImplementationOnce(() => fakeChildClose(1, '', 'venv failed'));
      const tool = new CreatePythonVenvTool();
      const result = await tool.execute(
        fileAction({
          target: { filePath: workspaceRoot },
          parameters: { path: '.venv', pythonExecutable: 'python3' },
        }),
        false
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('venv failed');
    });

    it('should report missing python executable as failure', async () => {
      mockSpawn.mockImplementationOnce(() => fakeChildError('spawn python ENOENT'));
      const tool = new CreatePythonVenvTool();
      const result = await tool.execute(
        fileAction({
          target: { filePath: workspaceRoot },
          parameters: { path: '.venv', pythonExecutable: 'python' },
        }),
        false
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to execute command');
    });

    it('should reject an absolute venv path outside the workspace', async () => {
      const tool = new CreatePythonVenvTool();
      const outside = resolve(workspaceRoot, '..', 'evil-venv');
      const result = await tool.execute(
        fileAction({
          target: { filePath: workspaceRoot },
          parameters: { path: outside },
        }),
        false
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside workspace');
    });
  });

  describe('RepairExecutor safety', () => {
    it('should fail when no tool is registered for the action type', async () => {
      const executor = createRepairExecutor(workspaceRoot);
      const result = await executor.executePlan(
        {
          id: 'plan-1',
          name: 'Test',
          description: 'Test',
          actions: [
            fileAction({
              id: 'action-1',
              type: 'install-tool' as RepairActionType,
              target: { filePath: workspaceRoot },
              parameters: { tool: 'docker' },
            }),
          ],
          requiresApproval: true,
        },
        { dryRun: false, workspaceRoot, approvalCallback: async () => 'allowed' }
      );
      expect(result.success).toBe(false);
      expect(result.results[0]?.result.error).toContain('No tool found');
    });

    it('should record validation failures without executing', async () => {
      const executor = createRepairExecutor(workspaceRoot);
      const result = await executor.executePlan(
        {
          id: 'plan-1',
          name: 'Test',
          description: 'Test',
          actions: [
            fileAction({
              id: 'action-1',
              type: 'install-dependency' as RepairActionType,
              target: { filePath: workspaceRoot },
              parameters: { ecosystem: 'npm', package: 'bad; rm -rf' },
            }),
          ],
          requiresApproval: true,
        },
        { dryRun: false, workspaceRoot, approvalCallback: async () => 'allowed' }
      );
      expect(result.success).toBe(false);
      expect(result.results[0]?.result.error).toContain('Invalid package name');
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should never create files in dry-run mode', async () => {
      const executor = createRepairExecutor(workspaceRoot);
      const result = await executor.executePlan(
        {
          id: 'plan-1',
          name: 'Test',
          description: 'Test',
          actions: [
            fileAction({
              id: 'action-1',
              target: { filePath: workspaceRoot },
              parameters: { path: 'dry.txt', content: 'x' },
              affectedFiles: ['dry.txt'],
            }),
          ],
          requiresApproval: true,
        },
        { dryRun: true, workspaceRoot, approvalCallback: async () => 'allowed' }
      );
      expect(result.success).toBe(true);
      const exists = await fs.access(join(workspaceRoot, 'dry.txt')).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it('should never execute denied actions on disk', async () => {
      const executor = createRepairExecutor(workspaceRoot);
      const result = await executor.executePlan(
        {
          id: 'plan-1',
          name: 'Test',
          description: 'Test',
          actions: [
            fileAction({
              id: 'action-1',
              target: { filePath: workspaceRoot },
              parameters: { path: 'denied.txt', content: 'x' },
              affectedFiles: ['denied.txt'],
            }),
          ],
          requiresApproval: true,
        },
        { dryRun: false, workspaceRoot, approvalCallback: async () => 'denied' }
      );
      expect(result.success).toBe(false);
      const exists = await fs.access(join(workspaceRoot, 'denied.txt')).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it('should write audit records for successful executions', async () => {
      const executor = createRepairExecutor(workspaceRoot);
      await executor.executePlan(
        {
          id: 'plan-1',
          name: 'Test',
          description: 'Test',
          actions: [
            fileAction({
              id: 'action-audit-1',
              target: { filePath: workspaceRoot },
              parameters: { path: 'audited.txt', content: 'x' },
              affectedFiles: ['audited.txt'],
            }),
          ],
          requiresApproval: true,
        },
        { dryRun: false, workspaceRoot, approvalCallback: async () => 'allowed' }
      );
      const logDir = join(workspaceRoot, '.resolveit/audit');
      const files = await fs.readdir(logDir);
      expect(files.length).toBeGreaterThan(0);
      let found = false;
      for (const file of files) {
        const content = await fs.readFile(join(logDir, file), 'utf-8');
        if (content.includes('action-audit-1') && content.includes('success')) {
          found = true;
        }
      }
      expect(found).toBe(true);
    });

    it('should write audit records for denied actions', async () => {
      const executor = createRepairExecutor(workspaceRoot);
      await executor.executePlan(
        {
          id: 'plan-1',
          name: 'Test',
          description: 'Test',
          actions: [
            fileAction({
              id: 'action-denied-1',
              target: { filePath: workspaceRoot },
              parameters: { path: 'denied.txt', content: 'x' },
              affectedFiles: ['denied.txt'],
            }),
          ],
          requiresApproval: true,
        },
        { dryRun: false, workspaceRoot, approvalCallback: async () => 'denied' }
      );
      const logDir = join(workspaceRoot, '.resolveit/audit');
      const files = await fs.readdir(logDir);
      let found = false;
      for (const file of files) {
        const content = await fs.readFile(join(logDir, file), 'utf-8');
        if (content.includes('action-denied-1') && content.includes('denied')) {
          found = true;
        }
      }
      expect(found).toBe(true);
    });

    it('should never log secrets in audit records', async () => {
      const executor = createRepairExecutor(workspaceRoot);
      await executor.executePlan(
        {
          id: 'plan-1',
          name: 'Test',
          description: 'Test',
          actions: [
            fileAction({
              id: 'action-secret-1',
              target: { filePath: workspaceRoot },
              parameters: { path: 's.txt', content: 'x', token: 'super-secret-value', password: 'hunter2' },
              affectedFiles: ['s.txt'],
            }),
          ],
          requiresApproval: true,
        },
        { dryRun: true, workspaceRoot, approvalCallback: async () => 'allowed' }
      );
      const logDir = join(workspaceRoot, '.resolveit/audit');
      const files = await fs.readdir(logDir);
      let combined = '';
      for (const file of files) {
        combined += await fs.readFile(join(logDir, file), 'utf-8');
      }
      expect(combined).not.toContain('super-secret-value');
      expect(combined).not.toContain('hunter2');
      expect(combined).toContain('[REDACTED]');
    });
  });

  describe('sanitizeParameters', () => {
    it('should redact sensitive keys including nested objects', () => {
      const result = sanitizeParameters({
        path: 's.txt',
        token: 'abc',
        api_key: 'def',
        nested: { password: 'x', safe: 'y' },
      });
      expect(result['path']).toBe('s.txt');
      expect(result['token']).toBe('[REDACTED]');
      expect(result['api_key']).toBe('[REDACTED]');
      expect((result['nested'] as Record<string, unknown>)['password']).toBe('[REDACTED]');
      expect((result['nested'] as Record<string, unknown>)['safe']).toBe('y');
    });
  });

  describe('SnapshotManager failure handling', () => {
    it('should return false when snapshot data is corrupted', async () => {
      await fs.writeFile(join(workspaceRoot, 'test.txt'), 'original', 'utf-8');
      const manager = createSnapshotManager(workspaceRoot);
      const snapshot = await manager.createSnapshot('action-1', ['test.txt']);
      await fs.writeFile(join(workspaceRoot, '.resolveit/snapshots', `${snapshot.id}.json`), 'not-json{{{', 'utf-8');
      const restored = await manager.restoreSnapshot(snapshot.id);
      expect(restored).toBe(false);
    });
  });

  describe('AuditLogger outcomes', () => {
    it('should log denied and failed entries', async () => {
      const logger = createAuditLogger(workspaceRoot);
      await logger.log({
        id: 'audit-denied',
        timestamp: new Date(),
        actionId: 'action-1',
        actionType: 'create-environment' as RepairActionType,
        permissionLevel: 'project-modification' as RiskLevel,
        approvalState: 'denied',
        target: { filePath: workspaceRoot },
        parameters: { path: 'x.txt' },
        affectedFiles: [],
        executionResult: 'failure',
        error: 'Action not approved',
      });
      const logDir = join(workspaceRoot, '.resolveit/audit');
      const files = await fs.readdir(logDir);
      const combined = (
        await Promise.all(files.map((f) => fs.readFile(join(logDir, f), 'utf-8')))
      ).join('\n');
      expect(combined).toContain('audit-denied');
      expect(combined).toContain('denied');
      expect(combined).toContain('Action not approved');
    });
  });

  describe('RepairPlanner workspace scope', () => {
    it('should scope planned actions to the workspace root', async () => {
      const planner = createRepairPlanner();
      const plan = await planner.createPlan(
        [
          {
            id: 'diag-1',
            code: 'MISSING_DEPENDENCY',
            severity: 'error',
            category: 'dependency',
            title: 'Missing dependency',
            message: 'lodash is missing',
            evidence: [],
            affectedFiles: ['package.json'],
            remediationCandidates: [
              {
                id: 'rem-1',
                type: 'install-dependency' as RepairActionType,
                description: 'Install lodash',
                confidence: 0.9,
                riskLevel: 'project-modification' as RiskLevel,
                payload: { ecosystem: 'npm', package: 'lodash' },
              },
            ],
            source: 'dependency-resolver',
            timestamp: new Date(),
            metadata: {},
          },
        ],
        {
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
          diagnosis: { id: 'd-1', summary: 'Test', rootCauses: [], confidence: 1, timestamp: new Date() },
          constraints: {
            maxRiskLevel: 'system-modification' as RiskLevel,
            allowedActions: ['install-dependency'] as RepairActionType[],
            requireApproval: true,
          },
        }
      );
      expect(plan.actions).toHaveLength(1);
      expect((plan.actions[0]?.parameters as Record<string, unknown>)['workspaceRoot']).toBe(workspaceRoot);
    });
  });
});
