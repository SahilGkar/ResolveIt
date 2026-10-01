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
import { sanitizeParameters as sanitizeRecord, redactSecrets } from '../safety/secrets.js';
import { SECURITY_LIMITS } from '../safety/limits.js';
import { createActionId, createAuditId, createPlanId, createSnapshotId } from '../safety/ids.js';
import { promises as fs } from 'fs';
import { resolve } from 'path';

const SNAPSHOT_DIR = '.resolveit/snapshots';
const AUDIT_LOG_DIR = '.resolveit/audit';

export function sanitizeParameters(parameters: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return sanitizeRecord(parameters);
}

function sanitizeAuditError(error: string | undefined): string | undefined {
  if (error === undefined) {
    return undefined;
  }
  return redactSecrets(error);
}

export interface RepairExecutionOptions {
  readonly dryRun: boolean;
  readonly workspaceRoot: string;
  readonly approvalCallback?: (action: RepairAction) => Promise<PermissionDecision>;
  readonly runId?: string;
}

export interface RepairExecutionResult {
  readonly plan: RepairPlan;
  readonly results: ReadonlyArray<{ action: RepairAction; result: RepairResult }>;
  readonly success: boolean;
}

export interface AuditQueryFilter {
  readonly startTime?: Date;
  readonly endTime?: Date;
  readonly actionId?: string;
  readonly runId?: string;
  readonly workspaceRoot?: string;
  readonly limit?: number;
}

export class RepairPlannerImpl {
  createPlan(diagnostics: ReadonlyArray<Diagnostic>, context: PlanContext): Promise<RepairPlan> {
    const actions: RepairAction[] = [];

    for (const diag of diagnostics) {
      if (diag.remediationCandidates && diag.remediationCandidates.length > 0) {
        for (const candidate of diag.remediationCandidates) {
          if (context.constraints.allowedActions.includes(candidate.type) &&
              this.riskLevelAllowed(candidate.riskLevel, context.constraints.maxRiskLevel)) {

            // Skip lockfile/transitive dependency install actions
            if (candidate.type === 'install-dependency' && diag.requirement) {
              const origin = (diag.requirement as any).origin;
              if (origin === 'lockfile' || origin === 'transitive') {
                continue;
              }
              const indirect = (diag.requirement as any).metadata?.indirect;
              if (indirect === true) {
                continue;
              }
            }

            const action: RepairAction = {
              id: createActionId(),
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
      id: createPlanId(),
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

function parseAuditRecord(raw: unknown): AuditLogEntry | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const id = record['id'];
  const actionId = record['actionId'];
  if (typeof id !== 'string' || typeof actionId !== 'string') {
    return undefined;
  }
  const timestamp = new Date(String(record['timestamp']));
  if (Number.isNaN(timestamp.getTime())) {
    return undefined;
  }
  const parameters =
    record['parameters'] !== null &&
    typeof record['parameters'] === 'object' &&
    !Array.isArray(record['parameters'])
      ? sanitizeRecord(record['parameters'] as Readonly<Record<string, unknown>>)
      : {};
  const actionType = typeof record['actionType'] === 'string' ? record['actionType'] : 'custom';
  const permissionLevel = typeof record['permissionLevel'] === 'string' ? record['permissionLevel'] : 'read-only';
  const approvalState = typeof record['approvalState'] === 'string' ? record['approvalState'] : 'denied';
  const target = record['target'] !== null && typeof record['target'] === 'object' ? record['target'] : {};
  const executionResult =
    record['executionResult'] === 'success' || record['executionResult'] === 'pending' ? record['executionResult'] : 'failure';
  return {
    id,
    timestamp,
    actionId,
    actionType: actionType as AuditLogEntry['actionType'],
    permissionLevel: permissionLevel as RiskLevel,
    approvalState: approvalState as PermissionDecision,
    target: target as AuditLogEntry['target'],
    parameters,
    affectedFiles: Array.isArray(record['affectedFiles'])
      ? (record['affectedFiles'] as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [],
    executionResult,
    ...(typeof record['error'] === 'string' ? { error: sanitizeAuditError(record['error']) } : {}),
    ...(typeof record['rollbackId'] === 'string' ? { rollbackId: record['rollbackId'] } : {}),
    ...(typeof record['runId'] === 'string' ? { runId: record['runId'] } : {}),
    ...(typeof record['workspaceRoot'] === 'string' ? { workspaceRoot: record['workspaceRoot'] } : {}),
    ...(typeof record['projectId'] === 'string' ? { projectId: record['projectId'] } : {}),
    ...(typeof record['reason'] === 'string' ? { reason: record['reason'] } : {}),
  };
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
    const sanitized: AuditLogEntry = {
      ...entry,
      parameters: sanitizeRecord(entry.parameters),
      error: sanitizeAuditError(entry.error),
    };
    const line = JSON.stringify({
      ...sanitized,
      timestamp: sanitized.timestamp.toISOString(),
    }) + '\n';

    await fs.appendFile(logFile, line, 'utf-8');
  }

  async query(filter: AuditQueryFilter = {}): Promise<ReadonlyArray<AuditLogEntry>> {
    const logDir = resolve(this.workspaceRoot, AUDIT_LOG_DIR);
    let files: string[];
    try {
      files = (await fs.readdir(logDir))
        .filter((name) => name.startsWith('audit-') && name.endsWith('.jsonl'))
        .sort();
    } catch {
      return [];
    }

    const limit = Math.min(filter.limit ?? SECURITY_LIMITS.maxAuditQueryResults, SECURITY_LIMITS.maxAuditQueryResults);
    const entries: AuditLogEntry[] = [];
    let bytesRead = 0;

    for (const file of files) {
      let content: string;
      try {
        content = await fs.readFile(resolve(logDir, file), 'utf-8');
      } catch {
        continue;
      }
      bytesRead += content.length;
      if (bytesRead > SECURITY_LIMITS.maxAuditFileBytes) {
        break;
      }
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(trimmed) as unknown;
        } catch {
          continue;
        }
        const entry = parseAuditRecord(raw);
        if (!entry) {
          continue;
        }
        if (filter.actionId !== undefined && entry.actionId !== filter.actionId) {
          continue;
        }
        if (filter.runId !== undefined && entry.runId !== filter.runId) {
          continue;
        }
        if (filter.workspaceRoot !== undefined && entry.workspaceRoot !== filter.workspaceRoot) {
          continue;
        }
        if (filter.startTime !== undefined && entry.timestamp < filter.startTime) {
          continue;
        }
        if (filter.endTime !== undefined && entry.timestamp > filter.endTime) {
          continue;
        }
        entries.push(entry);
      }
    }

    entries.sort((a, b) => {
      const timeDiff = a.timestamp.getTime() - b.timestamp.getTime();
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return entries.slice(0, limit);
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

    const snapshotId = createSnapshotId(actionId);
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
        id: createAuditId(),
        timestamp: new Date(),
        actionId: action.id,
        actionType: action.type,
        permissionLevel: action.permissionLevel,
        approvalState: decision,
        target: action.target,
        parameters: sanitizeRecord(action.parameters),
        affectedFiles: action.affectedFiles || [],
        executionResult: decision === 'allowed' ? 'pending' : 'failure',
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        workspaceRoot: effectiveRoot,
        ...(action.target.projectId === undefined ? {} : { projectId: action.target.projectId }),
        reason: decision === 'allowed' ? 'Approval granted; queued for execution' : 'Approval not granted; action skipped',
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

      let result: RepairResult;
      try {
        result = await tool.execute(action, options.dryRun);
      } catch (err) {
        result = {
          success: false,
          error: `Tool ${tool.name} threw an error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      results.push({ action, result });

      if (!result.success) {
        overallSuccess = false;
      }

      await auditLogger.log({
        id: createAuditId(),
        timestamp: new Date(),
        actionId: action.id,
        actionType: action.type,
        permissionLevel: action.permissionLevel,
        approvalState: 'allowed',
        target: action.target,
        parameters: sanitizeRecord(action.parameters),
        affectedFiles: action.affectedFiles || [],
        executionResult: result.success ? 'success' : 'failure',
        error: sanitizeAuditError(result.error),
        rollbackId: result.rollbackData ? `rollback-${action.id}` : undefined,
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        workspaceRoot: effectiveRoot,
        ...(action.target.projectId === undefined ? {} : { projectId: action.target.projectId }),
        reason: result.success ? 'Tool execution succeeded' : 'Tool execution failed',
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
