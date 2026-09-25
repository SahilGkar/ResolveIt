import { BaseRepairTool } from '../base-tool.js';
import type { ValidationResult, RepairResult, RepairAction } from '../../core/models.js';
import { promises as fs } from 'fs';
import { dirname } from 'path';

interface CreateFileParameters {
  readonly path: string;
  readonly content: string;
  readonly workspaceRoot?: string;
}

export class CreateFileTool extends BaseRepairTool {
  constructor() {
    super(
      'create-file',
      'Create a new file with specified content',
      'project-modification',
      ['create-environment', 'modify-configuration', 'update-manifest']
    );
  }

  override validate(action: RepairAction): ValidationResult {
    const baseValidation = super.validate(action);
    if (!baseValidation.valid) return baseValidation;

    const params = action.parameters as unknown as CreateFileParameters;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!params.path || typeof params.path !== 'string') {
      errors.push('Missing or invalid path parameter');
    }

    if (params.content === undefined || params.content === null) {
      errors.push('Missing content parameter');
    }

    if (params.path && params.path.includes('..')) {
      errors.push('Path contains directory traversal');
    }

    const rootResolution = this.resolveWorkspaceRoot(action, params);
    if (!rootResolution.ok) {
      errors.push(rootResolution.error);
    } else if (params.path) {
      const containment = this.validateWorkspacePath(rootResolution.root, params.path);
      for (const err of containment.errors) {
        if (!errors.includes(err)) {
          errors.push(err);
        }
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors, warnings };
    }

    return { valid: true, errors: [], warnings: [] };
  }

  override async execute(action: RepairAction, dryRun: boolean): Promise<RepairResult> {
    const validation = this.validate(action);
    if (!validation.valid) {
      return { success: false, error: validation.errors.join('; ') };
    }

    const params = action.parameters as unknown as CreateFileParameters;
    const rootResolution = this.resolveWorkspaceRoot(action, params);
    if (!rootResolution.ok) {
      return { success: false, error: rootResolution.error };
    }
    const workspaceRoot = rootResolution.root;

    const fullPath = this.resolveWorkspaceFile(workspaceRoot, params.path);

    if (dryRun) {
      return {
        success: true,
        output: `Would create file: ${params.path}`,
        modifiedFiles: [params.path],
      };
    }

    try {
      await fs.mkdir(dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, params.content, 'utf-8');

      return {
        success: true,
        output: `Created file: ${params.path}`,
        modifiedFiles: [params.path],
      };
    } catch (err) {
      return { success: false, error: `Failed to create file: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}