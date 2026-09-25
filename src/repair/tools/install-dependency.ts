import { BaseRepairTool } from '../base-tool.js';
import type { ValidationResult, RepairResult, RepairAction } from '../../core/models.js';
import { spawn } from 'child_process';

interface InstallDependencyParameters {
  readonly ecosystem: 'npm' | 'pip' | 'cargo' | 'go' | 'composer' | 'bundler';
  readonly package: string;
  readonly version?: string;
  readonly developmentOnly?: boolean;
  readonly workspaceRoot?: string;
}

const NPM_PACKAGE_PATTERN = /^(?:@[a-z0-9~][a-z0-9~._-]*\/)?[a-z0-9~][a-z0-9~._-]*$/;
const GENERIC_PACKAGE_PATTERN = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?(?:\[[A-Za-z0-9_,.-]+\])?$/;
const VERSION_PATTERN = /^[A-Za-z0-9_.\-+~^<>=!*|,\s:]+$/;

const ECOSYSTEM_COMMANDS: Record<InstallDependencyParameters['ecosystem'], { cmd: string; args: (params: InstallDependencyParameters) => string[] }> = {
  npm: {
    cmd: 'npm',
    args: (params) => {
      const base = ['install', '--save'];
      if (params.developmentOnly) base.push('--save-dev');
      const pkg = params.version ? `${params.package}@${params.version}` : params.package;
      base.push(pkg);
      return base;
    },
  },
  pip: {
    cmd: 'pip',
    args: (params) => {
      const base = ['install'];
      const pkg = params.version ? `${params.package}==${params.version}` : params.package;
      base.push(pkg);
      return base;
    },
  },
  cargo: {
    cmd: 'cargo',
    args: (params) => {
      const base = ['add'];
      if (params.developmentOnly) base.push('--dev');
      const pkg = params.version ? `${params.package}@${params.version}` : params.package;
      base.push(pkg);
      return base;
    },
  },
  go: {
    cmd: 'go',
    args: (params) => {
      const pkg = params.version ? `${params.package}@${params.version}` : params.package;
      return ['get', pkg];
    },
  },
  composer: {
    cmd: 'composer',
    args: (params) => {
      const base = ['require'];
      if (params.developmentOnly) base.push('--dev');
      const pkg = params.version ? `${params.package}:${params.version}` : params.package;
      base.push(pkg);
      return base;
    },
  },
  bundler: {
    cmd: 'bundle',
    args: (params) => {
      const base = ['add'];
      const pkg = params.version ? `${params.package}:${params.version}` : params.package;
      base.push(pkg);
      return base;
    },
  },
};

export class InstallDependencyTool extends BaseRepairTool {
  constructor() {
    super(
      'install-dependency',
      'Install a project dependency using the appropriate package manager',
      'project-modification',
      ['install-dependency']
    );
  }

  override validate(action: RepairAction): ValidationResult {
    const baseValidation = super.validate(action);
    if (!baseValidation.valid) return baseValidation;

    const params = action.parameters as unknown as InstallDependencyParameters;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!params.ecosystem || !ECOSYSTEM_COMMANDS[params.ecosystem]) {
      errors.push(`Unsupported ecosystem: ${params.ecosystem}. Supported: ${Object.keys(ECOSYSTEM_COMMANDS).join(', ')}`);
    }

    if (!params.package || typeof params.package !== 'string') {
      errors.push('Missing or invalid package parameter');
    } else {
      const packageError = this.validatePackageName(params.ecosystem, params.package);
      if (packageError) {
        errors.push(packageError);
      }
    }

    if (params.version !== undefined && params.version !== null) {
      const versionError = this.validateVersion(params.version);
      if (versionError) {
        errors.push(versionError);
      }
    }

    if (params.workspaceRoot && params.workspaceRoot.includes('..')) {
      errors.push('Workspace root contains directory traversal');
    }

    if (errors.length > 0) {
      return { valid: false, errors, warnings };
    }

    return { valid: true, errors: [], warnings };
  }

  private validatePackageName(ecosystem: unknown, packageName: string): string | undefined {
    if (packageName.trim() === '') {
      return 'Missing or invalid package parameter';
    }
    if (/\s/.test(packageName)) {
      return `Invalid package name (possible command injection): ${packageName}`;
    }
    const pattern = ecosystem === 'npm' ? NPM_PACKAGE_PATTERN : GENERIC_PACKAGE_PATTERN;
    if (!pattern.test(packageName)) {
      return `Invalid package name for ecosystem ${String(ecosystem)}: ${packageName}`;
    }
    return undefined;
  }

  private validateVersion(version: unknown): string | undefined {
    if (typeof version !== 'string' || version.trim() === '') {
      return 'Invalid version parameter';
    }
    if (/[;&|$`"'\n\r]/.test(version)) {
      return `Invalid version (possible command injection): ${version}`;
    }
    if (!VERSION_PATTERN.test(version)) {
      return `Invalid version: ${version}`;
    }
    return undefined;
  }

  override async execute(action: RepairAction, dryRun: boolean): Promise<RepairResult> {
    const validation = this.validate(action);
    if (!validation.valid) {
      return { success: false, error: validation.errors.join('; ') };
    }

    const params = action.parameters as unknown as InstallDependencyParameters;
    const rootResolution = this.resolveWorkspaceRoot(action, params);
    if (!rootResolution.ok) {
      return { success: false, error: rootResolution.error };
    }
    const workspaceRoot = rootResolution.root;

    const ecosystemDef = ECOSYSTEM_COMMANDS[params.ecosystem];
    const args = ecosystemDef.args(params);

    if (dryRun) {
      return {
        success: true,
        output: `Would run: ${ecosystemDef.cmd} ${args.join(' ')} in ${workspaceRoot}`,
        modifiedFiles: [],
      };
    }

    return new Promise((resolve) => {
      const child = spawn(ecosystemDef.cmd, args, {
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
            output: stdout,
            modifiedFiles: [],
          });
        } else {
          resolve({
            success: false,
            error: `Command failed with exit code ${code}: ${stderr || stdout}`,
          });
        }
      });

      child.on('error', (err) => {
        resolve({ success: false, error: `Failed to execute command: ${err.message}` });
      });
    });
  }
}