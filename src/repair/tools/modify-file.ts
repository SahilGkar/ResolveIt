import { BaseRepairTool } from '../base-tool.js';
import type { ValidationResult, RepairResult, RepairAction } from '../../core/models.js';
import { promises as fs } from 'fs';
import { SECURITY_LIMITS, byteLength } from '../../safety/limits.js';

interface ModifyFileParameters {
  readonly path: string;
  readonly find: string;
  readonly replace: string;
  readonly workspaceRoot?: string;
}

export class ModifyFileTool extends BaseRepairTool {
  constructor() {
    super(
      'modify-file',
      'Modify a file by replacing text',
      'project-modification',
      ['modify-configuration', 'update-manifest']
    );
  }

  override validate(action: RepairAction): ValidationResult {
    const baseValidation = super.validate(action);
    if (!baseValidation.valid) return baseValidation;

    const params = action.parameters as unknown as ModifyFileParameters;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!params.path || typeof params.path !== 'string') {
      errors.push('Missing or invalid path parameter');
    } else if (params.path.length > SECURITY_LIMITS.maxPathLength) {
      errors.push(`Path exceeds maximum length (${SECURITY_LIMITS.maxPathLength})`);
    }

    if (!params.find || typeof params.find !== 'string') {
      errors.push('Missing or invalid find parameter');
    } else if (byteLength(params.find) > SECURITY_LIMITS.maxFindReplaceBytes) {
      errors.push(`Find text exceeds maximum size (${SECURITY_LIMITS.maxFindReplaceBytes} bytes)`);
    }

    if (params.replace === undefined || params.replace === null) {
      errors.push('Missing replace parameter');
    } else if (typeof params.replace !== 'string') {
      errors.push('Invalid replace parameter: replace must be a string');
    } else if (byteLength(params.replace) > SECURITY_LIMITS.maxFindReplaceBytes) {
      errors.push(`Replacement text exceeds maximum size (${SECURITY_LIMITS.maxFindReplaceBytes} bytes)`);
    }

    const rootResolution = this.resolveWorkspaceRoot(action, params);
    if (!rootResolution.ok) {
      errors.push(rootResolution.error);
    } else if (params.path && typeof params.path === 'string') {
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

    return { valid: true, errors: [], warnings };
  }

  override async execute(action: RepairAction, dryRun: boolean): Promise<RepairResult> {
    const validation = this.validate(action);
    if (!validation.valid) {
      return { success: false, error: validation.errors.join('; ') };
    }

    const params = action.parameters as unknown as ModifyFileParameters;
    const rootResolution = this.resolveWorkspaceRoot(action, params);
    if (!rootResolution.ok) {
      return { success: false, error: rootResolution.error };
    }
    const workspaceRoot = rootResolution.root;

    if (dryRun) {
      return {
        success: true,
        output: `Would modify file: ${params.path}`,
        modifiedFiles: [params.path],
      };
    }

    const safe = await this.resolveSafeTarget(workspaceRoot, params.path);
    if (!safe.ok) {
      return { success: false, error: safe.error };
    }

    try {
      const stats = await fs.stat(safe.resolvedPath);
      if (stats.size > SECURITY_LIMITS.maxFileContentBytes) {
        return {
          success: false,
          error: `Refusing to modify file larger than ${SECURITY_LIMITS.maxFileContentBytes} bytes: ${params.path}`,
        };
      }
      const content = await fs.readFile(safe.resolvedPath, 'utf-8');

      if (!content.includes(params.find)) {
        return { success: false, error: `Text to find not found in file: ${params.find}` };
      }

      const newContent = content.replace(params.find, params.replace);
      if (byteLength(newContent) > SECURITY_LIMITS.maxFileContentBytes * 2) {
        return { success: false, error: 'Refusing to write file: result would exceed safe size limits' };
      }

      await fs.writeFile(safe.resolvedPath, newContent, 'utf-8');

      return {
        success: true,
        output: `Modified file: ${params.path}`,
        modifiedFiles: [params.path],
      };
    } catch (err) {
      return { success: false, error: `Failed to modify file: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
