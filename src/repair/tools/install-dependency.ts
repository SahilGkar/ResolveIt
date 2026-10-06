import { BaseRepairTool } from '../base-tool.js';
import type { ValidationResult, RepairResult, RepairAction } from '../../core/models.js';
import { createSafeCommandRunner } from '../../environment/command-runner.js';
import { SECURITY_LIMITS } from '../../safety/limits.js';

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
const SHELL_METACHAR_PATTERN = /[;&|$`"'\n\r()<>!*?~#\\]/;
// Mirrors UNSAFE_ARG_PATTERN in environment/command-runner.ts: characters the
// safe runner refuses on any command argument. A version range such as
// `^4.0.0` or `>=1.0.0` is a legitimate declaration (validation accepts it),
// but it can never be placed on a command line. In that case the installer
// runs against the bare package name and lets the package manager resolve the
// constraint from the project manifest, which remains the source of truth.
const RUNNER_UNSAFE_PATTERN = /[\0;&|$`'"\n\r()<>!^%]/;

function commandSafeSpecifier(pkg: string, version: string | undefined, joiner: string): string {
  if (!version || RUNNER_UNSAFE_PATTERN.test(version)) {
    return pkg;
  }
  return `${pkg}${joiner}${version}`;
}

const ECOSYSTEM_COMMANDS: Record<InstallDependencyParameters['ecosystem'], { cmd: string; args: (params: InstallDependencyParameters) => string[] }> = {
  npm: {
    cmd: 'npm',
    args: (params) => {
      const base = ['install', '--save'];
      if (params.developmentOnly) base.push('--save-dev');
      base.push(commandSafeSpecifier(params.package, params.version, '@'));
      return base;
    },
  },
  pip: {
    cmd: 'pip',
    args: (params) => {
      const base = ['install'];
      base.push(commandSafeSpecifier(params.package, params.version, '=='));
      return base;
    },
  },
  cargo: {
    cmd: 'cargo',
    args: (params) => {
      const base = ['add'];
      if (params.developmentOnly) base.push('--dev');
      base.push(commandSafeSpecifier(params.package, params.version, '@'));
      return base;
    },
  },
  go: {
    cmd: 'go',
    args: (params) => {
      return ['get', commandSafeSpecifier(params.package, params.version, '@')];
    },
  },
  composer: {
    cmd: 'composer',
    args: (params) => {
      const base = ['require'];
      if (params.developmentOnly) base.push('--dev');
      base.push(commandSafeSpecifier(params.package, params.version, ':'));
      return base;
    },
  },
  bundler: {
    cmd: 'bundle',
    args: (params) => {
      const base = ['add'];
      base.push(commandSafeSpecifier(params.package, params.version, ':'));
      return base;
    },
  },
};

const INSTALL_TIMEOUT_MS = 120000;

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

    if (params.developmentOnly !== undefined && typeof params.developmentOnly !== 'boolean') {
      errors.push('Invalid developmentOnly parameter: must be a boolean');
    }

    if (typeof params.workspaceRoot === 'string') {
      if (params.workspaceRoot.includes('\0')) {
        errors.push('Workspace root contains NUL byte');
      } else if (params.workspaceRoot.includes('..')) {
        errors.push('Workspace root contains directory traversal');
      }
    }

    for (const [key, value] of Object.entries(params)) {
      if (key === 'workspaceRoot' || key === 'package' || key === 'version') {
        continue;
      }
      if (typeof value === 'string' && SHELL_METACHAR_PATTERN.test(value)) {
        errors.push(`Invalid characters in parameter ${key}`);
      }
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
    if (packageName.length > SECURITY_LIMITS.maxPackageNameLength) {
      return `Invalid package name: exceeds maximum length (${SECURITY_LIMITS.maxPackageNameLength})`;
    }
    if (packageName.startsWith('-')) {
      return `Invalid package name (possible flag injection): ${packageName}`;
    }
    if (SHELL_METACHAR_PATTERN.test(packageName)) {
      return `Invalid package name (possible command injection): ${packageName}`;
    }
    if (/\s/.test(packageName)) {
      return `Invalid package name (possible command injection): ${packageName}`;
    }
    if (packageName.includes('..')) {
      return `Invalid package name (possible path traversal): ${packageName}`;
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
    if (version.length > SECURITY_LIMITS.maxVersionLength) {
      return `Invalid version: exceeds maximum length (${SECURITY_LIMITS.maxVersionLength})`;
    }
    if (SHELL_METACHAR_PATTERN.test(version)) {
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

    const runner = createSafeCommandRunner({
      allowedExecutables: [ecosystemDef.cmd],
      allowedRoot: workspaceRoot,
      defaultTimeoutMs: INSTALL_TIMEOUT_MS,
    });
    const result = await runner.run(ecosystemDef.cmd, args, {
      cwd: workspaceRoot,
      timeout: INSTALL_TIMEOUT_MS,
    });

    if (result.timedOut) {
      return { success: false, error: `Command timed out after ${INSTALL_TIMEOUT_MS}ms: ${ecosystemDef.cmd}` };
    }
    if (result.error) {
      return { success: false, error: `Failed to execute command: ${result.error}` };
    }
    if (result.exitCode === 0) {
      return { success: true, output: result.stdout, modifiedFiles: [] };
    }
    return {
      success: false,
      error: `Command failed with exit code ${result.exitCode}: ${result.stderr || result.stdout || result.error || 'unknown error'}`,
    };
  }
}
