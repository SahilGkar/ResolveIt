import type { RepairTool, ValidationResult, RepairResult, RepairAction, RiskLevel, RepairActionType } from '../core/models.js';
import { promises as fs } from 'fs';
import { resolve, isAbsolute, relative, dirname, parse, sep } from 'path';

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
    const errors: string[] = [];

    if (!workspaceRoot || typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
      errors.push('Missing workspace root for path validation');
      return { valid: false, errors, warnings: [] };
    }

    if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
      errors.push('Missing file path for path validation');
      return { valid: false, errors, warnings: [] };
    }

    if (this.containsTraversalSegments(filePath)) {
      errors.push(`File path contains directory traversal: ${filePath}`);
    }

    if (!this.isInsideWorkspace(workspaceRoot, filePath)) {
      errors.push(`File path ${filePath} is outside workspace`);
    }

    return { valid: errors.length === 0, errors, warnings: [] };
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
    if (isAbsolute(filePath)) {
      return resolve(filePath);
    }
    return resolve(workspaceRoot, filePath);
  }

  private containsTraversalSegments(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const segments = normalized.split('/');
    return segments.includes('..');
  }

  private isInsideWorkspace(workspaceRoot: string, filePath: string): boolean {
    const resolvedWorkspace = resolve(workspaceRoot);
    const resolvedCandidate = isAbsolute(filePath) ? resolve(filePath) : resolve(resolvedWorkspace, filePath);

    const workspaceRootPart = parse(resolvedWorkspace).root.toLowerCase();
    const candidateRootPart = parse(resolvedCandidate).root.toLowerCase();
    if (workspaceRootPart !== candidateRootPart) {
      return false;
    }

    const rel = relative(resolvedWorkspace, resolvedCandidate);
    if (rel === '') {
      return true;
    }
    if (isAbsolute(rel)) {
      return false;
    }
    const segments = rel.split(sep);
    if (segments[0] === '..') {
      return false;
    }
    return true;
  }

  protected async createSnapshot(workspaceRoot: string, filePath: string): Promise<string | undefined> {
    try {
      const fullPath = resolve(workspaceRoot, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      return content;
    } catch {
      return undefined;
    }
  }

  protected async writeFile(workspaceRoot: string, filePath: string, content: string): Promise<void> {
    const fullPath = this.resolveWorkspaceFile(workspaceRoot, filePath);
    await fs.mkdir(dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  }
}