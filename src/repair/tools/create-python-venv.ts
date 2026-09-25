import { BaseRepairTool } from '../base-tool.js';
import type { ValidationResult, RepairResult, RepairAction } from '../../core/models.js';
import { createSafeCommandRunner } from '../../environment/command-runner.js';
import { SECURITY_LIMITS } from '../../safety/limits.js';

const PYTHON_EXECUTABLE_PATTERN = /^(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?$/;
const VENV_TIMEOUT_MS = 120000;

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
    } else if (params.path.length > SECURITY_LIMITS.maxPathLength) {
      errors.push(`Path exceeds maximum length (${SECURITY_LIMITS.maxPathLength})`);
    }

    if (params.pythonExecutable !== undefined && params.pythonExecutable !== null) {
      if (typeof params.pythonExecutable !== 'string' || !PYTHON_EXECUTABLE_PATTERN.test(params.pythonExecutable)) {
        errors.push(`Invalid Python executable (possible command injection): ${String(params.pythonExecutable)}`);
      }
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

    const params = action.parameters as unknown as CreatePythonVenvParameters;
    const rootResolution = this.resolveWorkspaceRoot(action, params);
    if (!rootResolution.ok) {
      return { success: false, error: rootResolution.error };
    }
    const workspaceRoot = rootResolution.root;

    const pythonCmd = params.pythonExecutable || 'python';

    if (dryRun) {
      return {
        success: true,
        output: `Would create Python venv at: ${params.path} using ${pythonCmd}`,
        modifiedFiles: [params.path],
      };
    }

    const safe = await this.resolveSafeTarget(workspaceRoot, params.path);
    if (!safe.ok) {
      return { success: false, error: safe.error };
    }

    const runner = createSafeCommandRunner({
      allowedExecutables: [pythonCmd],
      allowedRoot: workspaceRoot,
      defaultTimeoutMs: VENV_TIMEOUT_MS,
    });
    const result = await runner.run(pythonCmd, ['-m', 'venv', safe.resolvedPath], {
      cwd: workspaceRoot,
      timeout: VENV_TIMEOUT_MS,
    });

    if (result.timedOut) {
      return { success: false, error: `Command timed out after ${VENV_TIMEOUT_MS}ms: ${pythonCmd} -m venv` };
    }
    if (result.error) {
      return { success: false, error: `Failed to execute command: ${result.error}` };
    }
    if (result.exitCode === 0) {
      return {
        success: true,
        output: `Created Python virtual environment at ${params.path}`,
        modifiedFiles: [params.path],
      };
    }
    return {
      success: false,
      error: `Failed to create venv (exit code ${result.exitCode}): ${result.stderr || result.stdout || result.error || 'unknown error'}`,
    };
  }
}
