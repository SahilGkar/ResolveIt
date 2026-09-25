import { BaseRepairTool } from '../base-tool.js';
import type { ValidationResult, RepairResult, RepairAction } from '../../core/models.js';
import { spawn } from 'child_process';

const PYTHON_EXECUTABLE_PATTERN = /^(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?$/;

interface CreatePythonVenvParameters {
  readonly path: string;
  readonly pythonExecutable?: string;
  readonly workspaceRoot?: string;
}

export class CreatePythonVenvTool extends BaseRepairTool {
  constructor() {
    super(
      'create-python-venv',
      'Create a Python virtual environment',
      'project-modification',
      ['create-environment']
    );
  }

  override validate(action: RepairAction): ValidationResult {
    const baseValidation = super.validate(action);
    if (!baseValidation.valid) return baseValidation;

    const params = action.parameters as unknown as CreatePythonVenvParameters;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!params.path || typeof params.path !== 'string') {
      errors.push('Missing or invalid path parameter');
    }

    if (params.path && params.path.includes('..')) {
      errors.push('Path contains directory traversal');
    }

    if (params.pythonExecutable !== undefined && params.pythonExecutable !== null) {
      if (typeof params.pythonExecutable !== 'string' || !PYTHON_EXECUTABLE_PATTERN.test(params.pythonExecutable)) {
        errors.push(`Invalid Python executable (possible command injection): ${String(params.pythonExecutable)}`);
      }
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

    return { valid: true, errors: [], warnings };
  }

  override async execute(action: RepairAction, dryRun: boolean): Promise<RepairResult> {
    const validation = this.validate(action);
    if (!validation.valid) {
      return { success: false, error: validation.errors.join('; ') };
    }

    const params = action.parameters as unknown as CreatePythonVenvParameters;
    const rootResolution = this.resolveWorkspaceRoot(action, params);
    if (!rootResolution.ok) {
      return { success: false, error: rootResolution.error };
    }
    const workspaceRoot = rootResolution.root;

    const pythonCmd = params.pythonExecutable || 'python';
    const venvPath = this.resolveWorkspaceFile(workspaceRoot, params.path);

    if (dryRun) {
      return {
        success: true,
        output: `Would create Python venv at: ${params.path} using ${pythonCmd}`,
        modifiedFiles: [params.path],
      };
    }

    return new Promise((resolve) => {
      const child = spawn(pythonCmd, ['-m', 'venv', venvPath], {
        cwd: workspaceRoot,
        shell: process.platform === 'win32',
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({
            success: true,
            output: `Created Python virtual environment at ${params.path}`,
            modifiedFiles: [params.path],
          });
        } else {
          resolve({
            success: false,
            error: `Failed to create venv (exit code ${code}): ${stderr || stdout}`,
          });
        }
      });

      child.on('error', (err) => {
        resolve({ success: false, error: `Failed to execute command: ${err.message}` });
      });
    });
  }
}