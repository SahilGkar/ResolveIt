import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { resolve, join } from 'path';
import { CreateFileTool } from '../src/repair/tools/create-file.js';
import { ModifyFileTool } from '../src/repair/tools/modify-file.js';
import { InstallDependencyTool } from '../src/repair/tools/install-dependency.js';
import { CreatePythonVenvTool } from '../src/repair/tools/create-python-venv.js';
import { RepairExecutor, createRepairExecutor, createRepairPlanner, createSnapshotManager, createAuditLogger } from '../src/repair/index.js';
import { RepairAction, RepairActionType, RiskLevel, PermissionDecision } from '../src/core/models.js';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';

const testWorkspace = join(tmpdir(), 'resolveit-test-');

describe('repair tools', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(testWorkspace);
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  describe('CreateFileTool', () => {
    it('should create a new file in dry-run mode', async () => {
      const tool = new CreateFileTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'create-environment',
        permissionLevel: 'project-modification',
        description: 'Create test file',
        target: { filePath: workspaceRoot },
        parameters: { path: 'test.txt', content: 'Hello World' },
        affectedFiles: ['test.txt'],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, true);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Would create file: test.txt');
      expect(result.modifiedFiles).toEqual(['test.txt']);
      
      const fileExists = await fs.access(join(workspaceRoot, 'test.txt')).then(() => true).catch(() => false);
      expect(fileExists).toBe(false);
    });

    it('should create a new file when not in dry-run mode', async () => {
      const tool = new CreateFileTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'create-environment',
        permissionLevel: 'project-modification',
        description: 'Create test file',
        target: { filePath: workspaceRoot },
        parameters: { path: 'test.txt', content: 'Hello World' },
        affectedFiles: ['test.txt'],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, false);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Created file: test.txt');
      
      const content = await fs.readFile(join(workspaceRoot, 'test.txt'), 'utf-8');
      expect(content).toBe('Hello World');
    });

    it('should validate missing path parameter', async () => {
      const tool = new CreateFileTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'create-environment',
        permissionLevel: 'project-modification',
        description: 'Create test file',
        target: { filePath: workspaceRoot },
        parameters: { content: 'Hello World' },
        affectedFiles: [],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing or invalid path parameter');
    });

    it('should validate missing content parameter', async () => {
      const tool = new CreateFileTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'create-environment',
        permissionLevel: 'project-modification',
        description: 'Create test file',
        target: { filePath: workspaceRoot },
        parameters: { path: 'test.txt' },
        affectedFiles: [],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing content parameter');
    });

    it('should reject directory traversal', async () => {
      const tool = new CreateFileTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'create-environment',
        permissionLevel: 'project-modification',
        description: 'Create test file',
        target: { filePath: workspaceRoot },
        parameters: { path: '../outside.txt', content: 'bad' },
        affectedFiles: [],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('directory traversal');
    });
  });

  describe('ModifyFileTool', () => {
    beforeEach(async () => {
      await fs.writeFile(join(workspaceRoot, 'test.txt'), 'Hello World', 'utf-8');
    });

    it('should modify a file in dry-run mode', async () => {
      const tool = new ModifyFileTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'modify-configuration',
        permissionLevel: 'project-modification',
        description: 'Modify test file',
        target: { filePath: workspaceRoot },
        parameters: { path: 'test.txt', find: 'World', replace: 'Universe' },
        affectedFiles: ['test.txt'],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, true);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Would modify file: test.txt');
      
      const content = await fs.readFile(join(workspaceRoot, 'test.txt'), 'utf-8');
      expect(content).toBe('Hello World');
    });

    it('should modify a file when not in dry-run mode', async () => {
      const tool = new ModifyFileTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'modify-configuration',
        permissionLevel: 'project-modification',
        description: 'Modify test file',
        target: { filePath: workspaceRoot },
        parameters: { path: 'test.txt', find: 'World', replace: 'Universe' },
        affectedFiles: ['test.txt'],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, false);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Modified file: test.txt');
      
      const content = await fs.readFile(join(workspaceRoot, 'test.txt'), 'utf-8');
      expect(content).toBe('Hello Universe');
    });

    it('should fail when find text not found', async () => {
      const tool = new ModifyFileTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'modify-configuration',
        permissionLevel: 'project-modification',
        description: 'Modify test file',
        target: { filePath: workspaceRoot },
        parameters: { path: 'test.txt', find: 'NotFound', replace: 'Replacement' },
        affectedFiles: ['test.txt'],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Text to find not found in file');
    });

    it('should validate missing path parameter', async () => {
      const tool = new ModifyFileTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'modify-configuration',
        permissionLevel: 'project-modification',
        description: 'Modify test file',
        target: { filePath: workspaceRoot },
        parameters: { find: 'World', replace: 'Universe' },
        affectedFiles: [],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing or invalid path parameter');
    });

    it('should validate missing find parameter', async () => {
      const tool = new ModifyFileTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'modify-configuration',
        permissionLevel: 'project-modification',
        description: 'Modify test file',
        target: { filePath: workspaceRoot },
        parameters: { path: 'test.txt', replace: 'Universe' },
        affectedFiles: [],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing or invalid find parameter');
    });

    it('should reject directory traversal', async () => {
      const tool = new ModifyFileTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'modify-configuration',
        permissionLevel: 'project-modification',
        description: 'Modify test file',
        target: { filePath: workspaceRoot },
        parameters: { path: '../outside.txt', find: 'a', replace: 'b' },
        affectedFiles: [],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('directory traversal');
    });
  });

  describe('InstallDependencyTool', () => {
    it('should validate ecosystem', async () => {
      const tool = new InstallDependencyTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'install-dependency',
        permissionLevel: 'project-modification',
        description: 'Install dependency',
        target: { filePath: workspaceRoot },
        parameters: { ecosystem: 'unknown', package: 'test' },
        affectedFiles: [],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported ecosystem');
    });

    it('should validate missing package parameter', async () => {
      const tool = new InstallDependencyTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'install-dependency',
        permissionLevel: 'project-modification',
        description: 'Install dependency',
        target: { filePath: workspaceRoot },
        parameters: { ecosystem: 'npm' },
        affectedFiles: [],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing or invalid package parameter');
    });

    it('should dry-run npm install', async () => {
      const tool = new InstallDependencyTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'install-dependency',
        permissionLevel: 'project-modification',
        description: 'Install axios',
        target: { filePath: workspaceRoot },
        parameters: { ecosystem: 'npm', package: 'axios', version: '^1.7.0', developmentOnly: false },
        affectedFiles: [],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, true);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Would run: npm install --save axios');
    });

    it('should dry-run npm install dev', async () => {
      const tool = new InstallDependencyTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'install-dependency',
        permissionLevel: 'project-modification',
        description: 'Install jest',
        target: { filePath: workspaceRoot },
        parameters: { ecosystem: 'npm', package: 'jest', version: '^29.0.0', developmentOnly: true },
        affectedFiles: [],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, true);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Would run: npm install --save --save-dev jest');
    });

    it('should dry-run pip install', async () => {
      const tool = new InstallDependencyTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'install-dependency',
        permissionLevel: 'project-modification',
        description: 'Install requests',
        target: { filePath: workspaceRoot },
        parameters: { ecosystem: 'pip', package: 'requests', version: '^2.31.0' },
        affectedFiles: [],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, true);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Would run: pip install requests');
    });

    it('should keep an exact version on the command line', async () => {
      const tool = new InstallDependencyTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'install-dependency',
        permissionLevel: 'project-modification',
        description: 'Install axios',
        target: { filePath: workspaceRoot },
        parameters: { ecosystem: 'npm', package: 'axios', version: '1.7.0', developmentOnly: false },
        affectedFiles: [],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, true);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Would run: npm install --save axios@1.7.0');
    });

    it('should never emit command-line arguments the safe runner rejects', async () => {
      const tool = new InstallDependencyTool();
      // Ranges the tool validates but cannot place on a command line fall back
      // to the bare package name; npm then resolves the manifest constraint.
      // (Ranges with shell-significant characters such as `|`, `>`, `~` never
      // get this far: they are rejected at validation.)
      const unsafeVersions = ['^1.7.0', '^29.0.0'];
      // Mirrors UNSAFE_ARG_PATTERN in environment/command-runner.ts.
      const runnerUnsafeChars = [';', '&', '|', '$', '`', "'", '"', '(', ')', '<', '>', '!', '^', '%'];
      for (const version of unsafeVersions) {
        const action: RepairAction = {
          id: 'action-1',
          type: 'install-dependency',
          permissionLevel: 'project-modification',
          description: `Install axios ${version}`,
          target: { filePath: workspaceRoot },
          parameters: { ecosystem: 'npm', package: 'axios', version, developmentOnly: false },
          affectedFiles: [],
          reversible: true,
          riskLevel: 'project-modification',
          prerequisites: [],
        };
        const result = await tool.execute(action, true);
        expect(result.success).toBe(true);
        const command = result.output ?? '';
        // The bare package name lets npm resolve the manifest constraint.
        expect(command).toContain('npm install --save axios');
        const args = command.slice(command.indexOf('axios'));
        for (const char of runnerUnsafeChars) {
          expect(args, `argument must not contain ${JSON.stringify(char)}`).not.toContain(char);
        }
      }
    });
    it('should reject shell-significant ranges at validation time', async () => {
      const tool = new InstallDependencyTool();
      for (const version of ['~1.7.0', '>=1.0.0', '>=1.0.0 <2.0.0', '1.0.0|2.0.0']) {
        const action: RepairAction = {
          id: 'action-1',
          type: 'install-dependency',
          permissionLevel: 'project-modification',
          description: `Install axios ${version}`,
          target: { filePath: workspaceRoot },
          parameters: { ecosystem: 'npm', package: 'axios', version, developmentOnly: false },
          affectedFiles: [],
          reversible: true,
          riskLevel: 'project-modification',
          prerequisites: [],
        };
        const result = await tool.execute(action, true);
        expect(result.success, version).toBe(false);
        expect(result.error ?? '').toContain('command injection');
      }
    });
  });

  describe('CreatePythonVenvTool', () => {
    it('should validate missing path parameter', async () => {
      const tool = new CreatePythonVenvTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'create-environment',
        permissionLevel: 'project-modification',
        description: 'Create venv',
        target: { filePath: workspaceRoot },
        parameters: { pythonExecutable: 'python3' },
        affectedFiles: [],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing or invalid path parameter');
    });

    it('should reject directory traversal', async () => {
      const tool = new CreatePythonVenvTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'create-environment',
        permissionLevel: 'project-modification',
        description: 'Create venv',
        target: { filePath: workspaceRoot },
        parameters: { path: '../outside' },
        affectedFiles: [],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('directory traversal');
    });

    it('should dry-run venv creation', async () => {
      const tool = new CreatePythonVenvTool();
      const action: RepairAction = {
        id: 'action-1',
        type: 'create-environment',
        permissionLevel: 'project-modification',
        description: 'Create venv',
        target: { filePath: workspaceRoot },
        parameters: { path: '.venv', pythonExecutable: 'python3' },
        affectedFiles: ['.venv'],
        reversible: true,
        riskLevel: 'project-modification',
        prerequisites: [],
      };

      const result = await tool.execute(action, true);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Would create Python venv at: .venv using python3');
    });
  });
});

describe('RepairExecutor integration', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(testWorkspace);
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('should execute a repair plan with approved actions', async () => {
    const executor = createRepairExecutor(workspaceRoot);
    
    const plan = {
      id: 'plan-1',
      name: 'Test Plan',
      description: 'Test',
      actions: [
        {
          id: 'action-1',
          type: 'create-environment' as RepairActionType,
          permissionLevel: 'project-modification' as RiskLevel,
          description: 'Create test file',
          target: { filePath: workspaceRoot },
          parameters: { path: 'created.txt', content: 'test content' },
          affectedFiles: ['created.txt'],
          reversible: true,
          estimatedImpact: 'Create file',
          requiresElevation: false,
          riskLevel: 'project-modification' as RiskLevel,
          prerequisites: [],
        },
      ],
      estimatedDuration: 5000,
      requiresApproval: true,
    };

    const approvalCallback = vi.fn().mockResolvedValue('allowed' as PermissionDecision);

    const result = await executor.executePlan(plan, {
      dryRun: false,
      workspaceRoot,
      approvalCallback,
    });

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].result.success).toBe(true);
    
    const content = await fs.readFile(join(workspaceRoot, 'created.txt'), 'utf-8');
    expect(content).toBe('test content');
  });

  it('should not execute denied actions', async () => {
    const executor = createRepairExecutor(workspaceRoot);
    
    const plan = {
      id: 'plan-1',
      name: 'Test Plan',
      description: 'Test',
      actions: [
        {
          id: 'action-1',
          type: 'create-environment' as RepairActionType,
          permissionLevel: 'project-modification' as RiskLevel,
          description: 'Create test file',
          target: { filePath: workspaceRoot },
          parameters: { path: 'created.txt', content: 'test content' },
          affectedFiles: ['created.txt'],
          reversible: true,
          estimatedImpact: 'Create file',
          requiresElevation: false,
          riskLevel: 'project-modification' as RiskLevel,
          prerequisites: [],
        },
      ],
      estimatedDuration: 5000,
      requiresApproval: true,
    };

    const approvalCallback = vi.fn().mockResolvedValue('denied' as PermissionDecision);

    const result = await executor.executePlan(plan, {
      dryRun: false,
      workspaceRoot,
      approvalCallback,
    });

    expect(result.success).toBe(false);
    expect(result.results[0].result.success).toBe(false);
    expect(result.results[0].result.error).toBe('Action not approved');
  });

  it('should create snapshots before file modifications', async () => {
    await fs.writeFile(join(workspaceRoot, 'existing.txt'), 'original content', 'utf-8');
    
    const executor = createRepairExecutor(workspaceRoot);
    
    const plan = {
      id: 'plan-1',
      name: 'Test Plan',
      description: 'Test',
      actions: [
        {
          id: 'action-1',
          type: 'modify-configuration' as RepairActionType,
          permissionLevel: 'project-modification' as RiskLevel,
          description: 'Modify file',
          target: { filePath: workspaceRoot },
          parameters: { path: 'existing.txt', find: 'original', replace: 'modified' },
          affectedFiles: ['existing.txt'],
          reversible: true,
          estimatedImpact: 'Modify file',
          requiresElevation: false,
          riskLevel: 'project-modification' as RiskLevel,
          prerequisites: [],
        },
      ],
      estimatedDuration: 5000,
      requiresApproval: true,
    };

    const approvalCallback = vi.fn().mockResolvedValue('allowed' as PermissionDecision);

    await executor.executePlan(plan, {
      dryRun: false,
      workspaceRoot,
      approvalCallback,
    });

    const snapshotDir = join(workspaceRoot, '.resolveit/snapshots');
    const snapshots = await fs.readdir(snapshotDir).catch(() => []);
    expect(snapshots.length).toBeGreaterThan(0);
  });
});

describe('SnapshotManager', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(testWorkspace);
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('should create and restore snapshot', async () => {
    await fs.writeFile(join(workspaceRoot, 'test.txt'), 'original', 'utf-8');
    
    const manager = createSnapshotManager(workspaceRoot);
    const snapshot = await manager.createSnapshot('action-1', ['test.txt']);
    
    expect(snapshot.id).toContain('snapshot-action-1');
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0].content).toBe('original');
    
    await fs.writeFile(join(workspaceRoot, 'test.txt'), 'modified', 'utf-8');
    
    const restored = await manager.restoreSnapshot(snapshot.id);
    expect(restored).toBe(true);
    
    const content = await fs.readFile(join(workspaceRoot, 'test.txt'), 'utf-8');
    expect(content).toBe('original');
  });

  it('should handle non-existent file in snapshot', async () => {
    const manager = createSnapshotManager(workspaceRoot);
    const snapshot = await manager.createSnapshot('action-1', ['nonexistent.txt']);
    
    expect(snapshot.files).toHaveLength(0);
  });

  it('should return false for invalid snapshot restore', async () => {
    const manager = createSnapshotManager(workspaceRoot);
    const restored = await manager.restoreSnapshot('invalid-id');
    expect(restored).toBe(false);
  });
});

describe('AuditLoggerImpl', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(testWorkspace);
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('should log audit entry', async () => {
    const logger = createAuditLogger(workspaceRoot);
    
    const entry = {
      id: 'audit-1',
      timestamp: new Date(),
      actionId: 'action-1',
      actionType: 'create-environment' as RepairActionType,
      permissionLevel: 'project-modification' as RiskLevel,
      approvalState: 'allowed' as PermissionDecision,
      target: { filePath: workspaceRoot },
      parameters: { path: 'test.txt', content: 'hello' },
      affectedFiles: ['test.txt'],
      executionResult: 'success' as const,
    };

    await logger.log(entry);
    
    const logDir = join(workspaceRoot, '.resolveit/audit');
    const logs = await fs.readdir(logDir);
    expect(logs.length).toBe(1);
    
    const content = await fs.readFile(join(logDir, logs[0]), 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.actionId).toBe('action-1');
    expect(parsed.actionType).toBe('create-environment');
    expect(parsed.approvalState).toBe('allowed');
  });
});

describe('RepairPlanner', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(testWorkspace);
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('should create plan from diagnostics with remediation candidates', async () => {
    const planner = createRepairPlanner();
    
    const diagnostics = [
      {
        id: 'diag-1',
        code: 'MISSING_DEPENDENCY',
        severity: 'error' as const,
        category: 'dependency' as const,
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
            payload: { ecosystem: 'npm', package: 'lodash', version: '^4.17.21' },
          },
        ],
        source: 'dependency-resolver' as const,
        timestamp: new Date(),
        metadata: {},
      },
    ];

    const context = {
      workspace: { id: 'ws-1', rootPath: workspaceRoot, projects: [], environments: [], allFiles: [], allDirectories: [], languages: [], projectMarkers: [], configFiles: [], repoIndicators: [], errors: [] },
      diagnosis: { id: 'diag-1', summary: 'Test', rootCauses: [], confidence: 1, timestamp: new Date() },
      constraints: {
        maxRiskLevel: 'system-modification' as RiskLevel,
        allowedActions: ['install-dependency'] as RepairActionType[],
        requireApproval: true,
      },
    };

    const plan = await planner.createPlan(diagnostics, context);
    
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('install-dependency');
    expect(plan.actions[0].parameters).toMatchObject({ ecosystem: 'npm', package: 'lodash', version: '^4.17.21' });
    expect((plan.actions[0].parameters as Record<string, unknown>)['workspaceRoot']).toBe(workspaceRoot);
  });

  it('should validate plan', async () => {
    const planner = createRepairPlanner();
    
    const validPlan = {
      id: 'plan-1',
      name: 'Test',
      description: 'Test',
      actions: [{ id: 'action-1', type: 'install-dependency' as RepairActionType, description: 'Test', target: {}, parameters: {}, riskLevel: 'project-modification' as RiskLevel, prerequisites: [] }],
      estimatedDuration: 5000,
      requiresApproval: true,
    };

    const invalidPlan = {
      id: 'plan-2',
      name: 'Test',
      description: 'Test',
      actions: [{ type: 'install-dependency' as RepairActionType, description: 'Test', target: {}, parameters: {}, riskLevel: 'project-modification' as RiskLevel, prerequisites: [] }],
      estimatedDuration: 5000,
      requiresApproval: true,
    };

    const validResult = planner.validatePlan(validPlan);
    expect(validResult.valid).toBe(true);

    const invalidResult = planner.validatePlan(invalidPlan);
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.errors).toContain('Action missing id');
  });
});