import type { 
  RepairAction, 
  RepairPlan, 
  RepairToolRegistry, 
  RepairResult, 
  ValidationResult, 
  Snapshot, 
  AuditLogEntry, 
  RiskLevel, 
  PermissionDecision,
  PlanContext,
  Diagnostic} from '../core/models.js';
import { createRepairToolRegistry } from './registry.js';
import { CreateFileTool } from './tools/create-file.js';
import { ModifyFileTool } from './tools/modify-file.js';
import { InstallDependencyTool } from './tools/install-dependency.js';
import { CreatePythonVenvTool } from './tools/create-python-venv.js';
import { PermissionManagerImpl } from '../safety/permission.js';
import { promises as fs } from 'fs';
import { resolve } from 'path';

const SNAPSHOT_DIR = '.resolveit/snapshots';
const AUDIT_LOG_DIR = '.resolveit/audit';

const SENSITIVE_PARAMETER_KEYS = new Set(
  [
    'password',
    'passwd',
    'secret',
    'token',
    'apikey',
    'authorization',
    'auth',
    'privatekey',
    'credential',
    'credentials',
  ].map((key) => key.toLowerCase()),
);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_PARAMETER_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));
}

export function sanitizeParameters(parameters: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (isSensitiveKey(key)) {
      sanitized[key] = '[REDACTED]';
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      sanitized[key] = sanitizeParameters(value as Readonly<Record<string, unknown>>);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export interface RepairExecutionOptions {
  readonly dryRun: boolean;
  readonly workspaceRoot: string;
  readonly approvalCallback?: (action: RepairAction) => Promise<PermissionDecision>;
}

export interface RepairExecutionResult {
  readonly plan: RepairPlan;
  readonly results: ReadonlyArray<{ action: RepairAction; result: RepairResult }>;
  readonly success: boolean;
}

export class RepairPlannerImpl {
  createPlan(diagnostics: ReadonlyArray<Diagnostic>, context: PlanContext): Promise<RepairPlan> {
    const actions: RepairAction[] = [];
     
    for (const diag of diagnostics) {
      if (diag.remediationCandidates && diag.remediationCandidates.length > 0) {
        for (const candidate of diag.remediationCandidates) {
          if (context.constraints.allowedActions.includes(candidate.type) &&
              this.riskLevelAllowed(candidate.riskLevel, context.constraints.maxRiskLevel)) {
            
            const action: RepairAction = {
              id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
              type: candidate.type,
              permissionLevel: candidate.riskLevel,
              description: candidate.description,
              target: { filePath: diag.affectedFiles?.[0] },
              parameters: {
                ...candidate.payload,
                workspaceRoot: context.workspace.rootPath,
              },
              affectedFiles: diag.affectedFiles,
              reversible: candidate.riskLevel !== 'system-modification',
              estimatedImpact: candidate.description,
              requiresElevation: candidate.riskLevel === 'system-modification',
              riskLevel: candidate.riskLevel,
              prerequisites: [],
            };
            
            actions.push(action);
          }
        }
      }
    }

    this.getMaxRiskLevel(actions);

    return Promise.resolve({
      id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name: `Repair plan for ${diagnostics.length} diagnostics`,
      description: `Generated plan to address ${diagnostics.length} diagnostics`,
      actions,
      estimatedDuration: actions.length * 5000,
      requiresApproval: actions.some(a => a.permissionLevel !== 'read-only'),
    });
  }

  validatePlan(plan: RepairPlan): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (plan.actions.length === 0) {
      warnings.push('Plan contains no actions');
    }

    for (const action of plan.actions) {
      if (!action.id) {
        errors.push('Action missing id');
      }
      if (!action.type) {
        errors.push('Action missing type');
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  private riskLevelAllowed(actionRisk: RiskLevel, maxRisk: RiskLevel): boolean {
    const riskOrder = { 'read-only': 0, 'project-modification': 1, 'system-modification': 2 };
    return riskOrder[actionRisk] <= riskOrder[maxRisk];
  }

  private getMaxRiskLevel(actions: ReadonlyArray<RepairAction>): RiskLevel {
    const riskOrder = { 'read-only': 0, 'project-modification': 1, 'system-modification': 2 };
    let max = 'read-only' as RiskLevel;
    for (const action of actions) {
      if (riskOrder[action.riskLevel] > riskOrder[max]) {
        max = action.riskLevel;
      }
    }
    return max;
  }
}

export class AuditLoggerImpl {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  async log(entry: AuditLogEntry): Promise<void> {
    const logDir = resolve(this.workspaceRoot, AUDIT_LOG_DIR);
    await fs.mkdir(logDir, { recursive: true });
    
    const logFile = resolve(logDir, `audit-${new Date().toISOString().split('T')[0]}.jsonl`);
    const line = JSON.stringify({
      ...entry,
      timestamp: entry.timestamp.toISOString(),
    }) + '\n';
    
    await fs.appendFile(logFile, line, 'utf-8');
  }

  query(_query: { startTime?: Date; endTime?: Date; actionId?: string; limit?: number }): Promise<ReadonlyArray<AuditLogEntry>> {
    // Simplified implementation - in practice would read from log files
    return Promise.resolve([]);
  }
}

export class SnapshotManager {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  async createSnapshot(actionId: string, files: ReadonlyArray<string>): Promise<Snapshot> {
    const snapshotDir = resolve(this.workspaceRoot, SNAPSHOT_DIR);
    await fs.mkdir(snapshotDir, { recursive: true });
    
    const snapshotId = `snapshot-${actionId}-${Date.now()}`;
    const snapshotFiles: Array<{ filePath: string; content: string; timestamp: Date }> = [];
    
    for (const file of files) {
      try {
        const fullPath = resolve(this.workspaceRoot, file);
        const content = await fs.readFile(fullPath, 'utf-8');
        snapshotFiles.push({ filePath: file, content, timestamp: new Date() });
      } catch {
        // File doesn't exist yet, that's fine
      }
    }
    
    const snapshot: Snapshot = {
      id: snapshotId,
      actionId,
      files: snapshotFiles,
      createdAt: new Date(),
    };
    
    const snapshotFile = resolve(snapshotDir, `${snapshotId}.json`);
    await fs.writeFile(snapshotFile, JSON.stringify(snapshot, null, 2), 'utf-8');
    
    return snapshot;
  }

  async restoreSnapshot(snapshotId: string): Promise<boolean> {
    try {
      const snapshotDir = resolve(this.workspaceRoot, SNAPSHOT_DIR);
      const snapshotFile = resolve(snapshotDir, `${snapshotId}.json`);
      const content = await fs.readFile(snapshotFile, 'utf-8');
      const snapshot = JSON.parse(content) as Snapshot;
      
      for (const file of snapshot.files) {
        const fullPath = resolve(this.workspaceRoot, file.filePath);
        await fs.writeFile(fullPath, file.content, 'utf-8');
      }
      
      return true;
    } catch {
      return false;
    }
  }
}

export class RepairExecutor {
  private registry: RepairToolRegistry;
  private auditLogger: AuditLoggerImpl;
  private snapshotManager: SnapshotManager;
  private permissionManager: PermissionManagerImpl;
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.registry = createRepairToolRegistry();
    this.auditLogger = new AuditLoggerImpl(workspaceRoot);
    this.snapshotManager = new SnapshotManager(workspaceRoot);
    this.permissionManager = new PermissionManagerImpl();
    this.registerDefaultTools();
  }

  private registerDefaultTools(): void {
    this.registry.register(new CreateFileTool());
    this.registry.register(new ModifyFileTool());
    this.registry.register(new InstallDependencyTool());
    this.registry.register(new CreatePythonVenvTool());
  }

  getRegistry(): RepairToolRegistry {
    return this.registry;
  }

  getPermissionManager(): PermissionManagerImpl {
    return this.permissionManager;
  }

  async executePlan(
    plan: RepairPlan,
    options: RepairExecutionOptions
  ): Promise<RepairExecutionResult> {
    const results: Array<{ action: RepairAction; result: RepairResult }> = [];
    let overallSuccess = true;
    const effectiveRoot = options.workspaceRoot || this.workspaceRoot;
    const auditLogger = options.workspaceRoot && options.workspaceRoot !== this.workspaceRoot
      ? new AuditLoggerImpl(effectiveRoot)
      : this.auditLogger;
    const snapshotManager = options.workspaceRoot && options.workspaceRoot !== this.workspaceRoot
      ? new SnapshotManager(effectiveRoot)
      : this.snapshotManager;

    for (const action of plan.actions) {
      let decision: PermissionDecision;
      
      if (options.approvalCallback) {
        decision = await options.approvalCallback(action);
      } else {
        const approvalResult = this.permissionManager.requestApproval(action, `Action required to fix diagnostic`);
        decision = approvalResult.approved ? 'allowed' : (approvalResult.rejectedActions.length > 0 ? 'denied' : 'requires-approval');
      }

      await auditLogger.log({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        timestamp: new Date(),
        actionId: action.id,
        actionType: action.type,
        permissionLevel: action.permissionLevel,
        approvalState: decision,
        target: action.target,
        parameters: sanitizeParameters(action.parameters),
        affectedFiles: action.affectedFiles || [],
        executionResult: decision === 'allowed' ? 'pending' : 'failure',
      });

      if (decision !== 'allowed') {
        results.push({ action, result: { success: false, error: 'Action not approved' } });
        overallSuccess = false;
        continue;
      }

      const tool = this.registry.findToolForAction(action);
      if (!tool) {
        const result = { success: false, error: `No tool found for action type: ${action.type}` };
        results.push({ action, result });
        overallSuccess = false;
        continue;
      }

      const validation = tool.validate(action);
      if (!validation.valid) {
        const result = { success: false, error: validation.errors.join('; ') };
        results.push({ action, result });
        overallSuccess = false;
        continue;
      }

      if (action.affectedFiles && action.affectedFiles.length > 0 && !options.dryRun) {
        await snapshotManager.createSnapshot(action.id, action.affectedFiles);
      }

      const result = await tool.execute(action, options.dryRun);
      results.push({ action, result });

      if (!result.success) {
        overallSuccess = false;
      }

      await auditLogger.log({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        timestamp: new Date(),
        actionId: action.id,
        actionType: action.type,
        permissionLevel: action.permissionLevel,
        approvalState: 'allowed',
        target: action.target,
        parameters: sanitizeParameters(action.parameters),
        affectedFiles: action.affectedFiles || [],
        executionResult: result.success ? 'success' : 'failure',
        error: result.error,
        rollbackId: result.rollbackData ? `rollback-${action.id}` : undefined,
      });
    }

    return { plan, results, success: overallSuccess };
  }
}

export function createRepairExecutor(workspaceRoot: string): RepairExecutor {
  return new RepairExecutor(workspaceRoot);
}

export function createRepairPlanner(): RepairPlannerImpl {
  return new RepairPlannerImpl();
}

export function createAuditLogger(workspaceRoot: string): AuditLoggerImpl {
  return new AuditLoggerImpl(workspaceRoot);
}

export function createSnapshotManager(workspaceRoot: string): SnapshotManager {
  return new SnapshotManager(workspaceRoot);
}