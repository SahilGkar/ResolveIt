import type { ProjectRequirement, ParsedRequirements, RequirementParseError, RequirementParser } from '../../core/interfaces.js';

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: {
    node?: string;
    npm?: string;
    yarn?: string;
    pnpm?: string;
  };
  packageManager?: string;
  volta?: {
    node?: string;
    npm?: string;
    yarn?: string;
    pnpm?: string;
  };
  workspaces?: string[] | { packages: string[] };
}

export class NodeRequirementParser implements RequirementParser {
  readonly ecosystem = 'node';
  readonly supportedFormats = ['package.json'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const pkg = JSON.parse(content) as PackageJson;

      // Runtime version requirements from engines
      if (pkg.engines?.node) {
        requirements.push({
          id: `req-${Date.now()}-node`,
          ecosystem: 'node',
          type: 'runtime-version',
          name: 'node',
          versionConstraint: pkg.engines.node,
          rawConstraint: pkg.engines.node,
          sourceFile,
          sourceSection: 'engines.node',
          metadata: { type: 'runtime' },
        });
      }

      if (pkg.engines?.npm) {
        requirements.push({
          id: `req-${Date.now()}-npm`,
          ecosystem: 'node',
          type: 'package-manager',
          name: 'npm',
          versionConstraint: pkg.engines.npm,
          rawConstraint: pkg.engines.npm,
          sourceFile,
          sourceSection: 'engines.npm',
          metadata: { type: 'package-manager' },
        });
      }

      if (pkg.engines?.yarn) {
        requirements.push({
          id: `req-${Date.now()}-yarn`,
          ecosystem: 'node',
          type: 'package-manager',
          name: 'yarn',
          versionConstraint: pkg.engines.yarn,
          rawConstraint: pkg.engines.yarn,
          sourceFile,
          sourceSection: 'engines.yarn',
          metadata: { type: 'package-manager' },
        });
      }

      if (pkg.engines?.pnpm) {
        requirements.push({
          id: `req-${Date.now()}-pnpm`,
          ecosystem: 'node',
          type: 'package-manager',
          name: 'pnpm',
          versionConstraint: pkg.engines.pnpm,
          rawConstraint: pkg.engines.pnpm,
          sourceFile,
          sourceSection: 'engines.pnpm',
          metadata: { type: 'package-manager' },
        });
      }

      if (pkg.packageManager) {
        requirements.push({
          id: `req-${Date.now()}-packageManager`,
          ecosystem: 'node',
          type: 'package-manager',
          name: pkg.packageManager.split('@')[0] || 'unknown',
          versionConstraint: pkg.packageManager.includes('@') ? pkg.packageManager.split('@')[1] : undefined,
          rawConstraint: pkg.packageManager,
          sourceFile,
          sourceSection: 'packageManager',
          metadata: { type: 'package-manager', config: 'packageManager' },
        });
      }

      if (pkg.volta?.node) {
        requirements.push({
          id: `req-${Date.now()}-volta-node`,
          ecosystem: 'node',
          type: 'runtime-version',
          name: 'node',
          versionConstraint: `==${pkg.volta.node}`,
          rawConstraint: pkg.volta.node,
          sourceFile,
          sourceSection: 'volta.node',
          metadata: { type: 'runtime', config: 'volta' },
        });
      }

      for (const manager of ['npm', 'yarn', 'pnpm'] as const) {
        const pinned = pkg.volta?.[manager];
        if (pinned) {
          requirements.push({
            id: `req-${Date.now()}-volta-${manager}`,
            ecosystem: 'node',
            type: 'package-manager',
            name: manager,
            versionConstraint: `==${pinned}`,
            rawConstraint: pinned,
            sourceFile,
            sourceSection: `volta.${manager}`,
            metadata: { type: 'package-manager', config: 'volta' },
          });
        }
      }

      // Parse dependencies
      const parseDeps = (deps: Record<string, string> | undefined, scope: 'production' | 'development' | 'optional' | 'peer'): void => {
        if (!deps) return;
        for (const [name, version] of Object.entries(deps)) {
          requirements.push({
            id: `req-${Date.now()}-${name}`,
            ecosystem: 'node',
            type: 'package-dependency',
            name,
            versionConstraint: version,
            rawConstraint: version,
            sourceFile,
            sourceSection: `dependencies.${scope}`,
            optional: scope === 'optional',
            developmentOnly: scope === 'development',
            metadata: { scope },
          });
        }
      };

      parseDeps(pkg.dependencies, 'production');
      parseDeps(pkg.devDependencies, 'development');
      parseDeps(pkg.optionalDependencies, 'optional');
      parseDeps(pkg.peerDependencies, 'peer');

    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse package.json: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PARSE_ERROR',
        severity: 'error',
      });
    }

    return {
      projectId: 'unknown',
      sourceFiles: [sourceFile],
      requirements,
      parseErrors: errors,
    };
  }
}