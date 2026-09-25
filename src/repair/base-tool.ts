import type { RepairTool, ValidationResult, RepairResult, RepairAction, RiskLevel, RepairActionType } from '../core/models.js';
import { promises as fs } from 'fs';
import { resolve, dirname } from 'path';
import { checkWorkspaceContainment, verifyWorkspaceTarget } from '../safety/paths.js';

export abstract class BaseRepairTool implements RepairTool {
  readonly name: string;
  readonly description: string;
  readonly permissionLevel: RiskLevel;
  readonly supportedActionTypes: ReadonlyArray<RepairActionType>;

  constructor(
    name: string,
    description: string,
    permissionLevel: RiskLevel,
    supportedActionTypes: ReadonlyArray<RepairActionType>
  ) {
    this.name = name;
    this.description = description;
    this.permissionLevel = permissionLevel;
    this.supportedActionTypes = supportedActionTypes;
  }

  validate(action: RepairAction): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!this.supportedActionTypes.includes(action.type)) {
      errors.push(`Action type ${action.type} not supported by tool ${this.name}`);
    }

    if (action.permissionLevel !== this.permissionLevel) {
      warnings.push(`Action permission level (${action.permissionLevel}) differs from tool permission level (${this.permissionLevel})`);
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  abstract execute(action: RepairAction, dryRun: boolean): Promise<RepairResult>;

  protected validateWorkspacePath(workspaceRoot: string, filePath: string): ValidationResult {
    const result = checkWorkspaceContainment(workspaceRoot, filePath);
    if (result.ok) {
      return { valid: true, errors: [], warnings: [] };
    }
    return { valid: false, errors: [result.error], warnings: [] };
  }

  protected resolveWorkspaceRoot(
    action: RepairAction,
    params: { readonly workspaceRoot?: unknown }
  ): { readonly ok: true; readonly root: string } | { readonly ok: false; readonly error: string } {
    const candidate = params.workspaceRoot ?? action.target.filePath;

    if (typeof candidate !== 'string' || candidate.trim() === '') {
      return {
        ok: false,
        error: 'Missing workspace root: provide parameters.workspaceRoot or action.target.filePath',
      };
    }

    return { ok: true, root: resolve(candidate) };
  }

  protected resolveWorkspaceFile(workspaceRoot: string, filePath: string): string {
    const checked = checkWorkspaceContainment(workspaceRoot, filePath);
    if (!checked.ok) {
      throw new Error(checked.error);
    }
    return checked.resolvedPath;
  }

  protected async resolveSafeTarget(
    workspaceRoot: string,
    filePath: string
  ): Promise<{ readonly ok: true; readonly resolvedPath: string } | { readonly ok: false; readonly error: string }> {
    return verifyWorkspaceTarget(workspaceRoot, filePath);
  }

  protected async createSnapshot(workspaceRoot: string, filePath: string): Promise<string | undefined> {
    try {
      const fullPath = this.resolveWorkspaceFile(workspaceRoot, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      return content;
    } catch {
      return undefined;
    }
  }

  protected async writeFile(workspaceRoot: string, filePath: string, content: string): Promise<void> {
    const safe = await this.resolveSafeTarget(workspaceRoot, filePath);
    if (!safe.ok) {
      throw new Error(safe.error);
    }
    await fs.mkdir(dirname(safe.resolvedPath), { recursive: true });
    await fs.writeFile(safe.resolvedPath, content, 'utf-8');
  }
}
