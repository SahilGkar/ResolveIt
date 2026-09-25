import type { ProjectRequirement, ParsedRequirements, RequirementParseError, RequirementParser } from '../../core/interfaces.js';
import { formatMatchesAny } from '../projects.js';

export class RubyRequirementParser implements RequirementParser {
  readonly ecosystem = 'ruby';
  readonly supportedFormats = ['Gemfile', 'Gemfile.lock', 'gemspec'];

  canParse(fileName: string): boolean {
    const normalized = fileName.toLowerCase();
    const base = normalized.split('/').pop() ?? '';
    if (formatMatchesAny(['Gemfile', 'Gemfile.lock'], base)) {
      return true;
    }
    return base.endsWith('.gemspec');
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const fileName = sourceFile.split('/').pop()?.toLowerCase() || '';

      if (fileName === 'gemfile') {
        const lines = content.split('\n');
        let inGroup = false;
        let currentGroup = '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;

          if (trimmed.startsWith('ruby ')) {
            const versionMatch = trimmed.match(/ruby\s+['"]([^'"]+)['"]/);
            if (versionMatch && versionMatch[1]) {
              requirements.push({
                id: `req-${Date.now()}-ruby`,
                ecosystem: 'ruby',
                type: 'runtime-version',
                name: 'ruby',
                versionConstraint: versionMatch[1],
                rawConstraint: versionMatch[1],
                sourceFile,
                sourceSection: 'ruby directive',
                metadata: { type: 'runtime' },
              });
            }
          }

          const gemMatch = trimmed.match(/gem\s+['"]([^'"]+)['"]\s*(.*)$/);
          if (gemMatch && gemMatch[1]) {
            const name = gemMatch[1];
            const rest = gemMatch[2] ?? '';
            const quoted = [...rest.matchAll(/['"]([^'"]+)['"]/g)].map((part) => part[1] ?? '').filter((part) => part !== '');
            const version = quoted.length > 0 ? quoted.join(', ') : '*';
            requirements.push({
              id: `req-${Date.now()}-${name}`,
              ecosystem: 'ruby',
              type: 'package-dependency',
              name,
              versionConstraint: version,
              rawConstraint: version,
              sourceFile,
              sourceSection: 'Gemfile',
              developmentOnly: inGroup && currentGroup === 'development',
              metadata: { type: 'gem', group: currentGroup },
            });
          }

          if (trimmed.startsWith('group ')) {
            const groupMatch = trimmed.match(/group\s+:?['"]?(\w+)/);
            if (groupMatch && groupMatch[1]) {
              currentGroup = groupMatch[1];
              inGroup = true;
            }
          } else if (trimmed === 'end' && inGroup) {
            inGroup = false;
            currentGroup = '';
          }
        }
      } else if (fileName === 'gemfile.lock') {        let section = '';
        for (const rawLine of content.split('\n')) {
          const line = rawLine.trim();
          if (!line) {
            continue;
          }
          if (!rawLine.startsWith(' ') && !rawLine.startsWith('\t')) {
            section = line;
            continue;
          }
          if (section === 'GEM') {
            if (/^remote:/.test(line) || /^specs:/.test(line)) {
              continue;
            }
            const specMatch = line.match(/^([^\s(]+)\s*\(([^)]+)\)/);
            if (specMatch && specMatch[1] && specMatch[2] !== undefined) {
              requirements.push({
                id: `req-${Date.now()}-${specMatch[1]}`,
                ecosystem: 'ruby',
                type: 'package-dependency',
                name: specMatch[1],
                versionConstraint: `==${specMatch[2].trim()}`,
                rawConstraint: specMatch[2].trim(),
                resolvedVersion: specMatch[2].trim(),
                origin: 'lockfile',
                lockfileSource: 'Gemfile.lock',
                sourceFile,
                sourceSection: 'GEM.specs',
                metadata: { type: 'gem', locked: true },
              });
            }
          } else if (section === 'RUBY VERSION') {
            const rubyMatch = line.match(/^ruby\s+([^\s]+)/);
            if (rubyMatch && rubyMatch[1]) {
              requirements.push({
                id: `req-${Date.now()}-ruby`,
                ecosystem: 'ruby',
                type: 'runtime-version',
                name: 'ruby',
                versionConstraint: rubyMatch[1],
                rawConstraint: rubyMatch[1],
                sourceFile,
                sourceSection: 'RUBY VERSION',
                metadata: { type: 'runtime', locked: true },
              });
            }
          } else if (section === 'BUNDLED WITH') {
            requirements.push({
              id: `req-${Date.now()}-bundler`,
              ecosystem: 'ruby',
              type: 'toolchain',
              name: 'bundler',
              versionConstraint: line,
              rawConstraint: line,
              sourceFile,
              sourceSection: 'BUNDLED WITH',
              metadata: { type: 'toolchain', locked: true },
            });
          }
        }
      } else if (fileName === 'gemspec' || fileName.endsWith('.gemspec')) {
        const depRegex = /s\.(add_runtime_dependency|add_development_dependency)\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?\s*\)/g;
        let match;
        while ((match = depRegex.exec(content)) !== null) {
          if (match[1] && match[2]) {
            const type = match[1];
            const name = match[2];
            const version = match[3] || '*';

            requirements.push({
              id: `req-${Date.now()}-${name}`,
              ecosystem: 'ruby',
              type: 'package-dependency',
              name,
              versionConstraint: version,
              rawConstraint: version,
              sourceFile,
              sourceSection: `gemspec.${type}`,
              developmentOnly: type === 'add_development_dependency',
              metadata: { type: 'gem' },
            });
          }
        }
      }
    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse Ruby file: ${err instanceof Error ? err.message : String(err)}`,
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

export class PHPRequirementParser implements RequirementParser {
  readonly ecosystem = 'php';
  readonly supportedFormats = ['composer.json', 'composer.lock'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const fileName = sourceFile.split('/').pop()?.toLowerCase() || '';

      if (fileName === 'composer.json') {
        const composer = JSON.parse(content) as { require?: Record<string, string>; 'require-dev'?: Record<string, string> };

        if (composer.require && composer.require.php) {
          requirements.push({
            id: `req-${Date.now()}-php`,
            ecosystem: 'php',
            type: 'runtime-version',
            name: 'php',
            versionConstraint: composer.require.php,
            rawConstraint: composer.require.php,
            sourceFile,
            sourceSection: 'require.php',
            metadata: { type: 'runtime' },
          });
        }

        if (composer.require) {
          for (const [name, version] of Object.entries(composer.require)) {
            if (name !== 'php') {
              if (name.startsWith('ext-') || name.startsWith('lib-')) {
                requirements.push({
                  id: `req-${Date.now()}-${name}`,
                  ecosystem: 'php',
                  type: 'system-tool',
                  name,
                  versionConstraint: String(version),
                  rawConstraint: String(version),
                  sourceFile,
                  sourceSection: 'require',
                  metadata: { type: 'extension' },
                });
              } else {
                requirements.push({
                  id: `req-${Date.now()}-${name}`,
                  ecosystem: 'php',
                  type: 'package-dependency',
                  name,
                  versionConstraint: String(version),
                  rawConstraint: String(version),
                  sourceFile,
                  sourceSection: 'require',
                  metadata: { type: 'package' },
                });
              }
            }
          }
        }

        if (composer['require-dev'] && typeof composer['require-dev'] === 'object') {
          for (const [name, version] of Object.entries(composer['require-dev'])) {
            requirements.push({
              id: `req-${Date.now()}-${name}-dev`,
              ecosystem: 'php',
              type: 'package-dependency',
              name,
              versionConstraint: String(version),
              rawConstraint: String(version),
              sourceFile,
              sourceSection: 'require-dev',
              developmentOnly: true,
              metadata: { type: 'package' },
            });
          }
        }
      } else if (fileName === 'composer.lock') {
        const lock = JSON.parse(content) as {
          packages?: Array<{ name?: string; version?: string }>;
          'packages-dev'?: Array<{ name?: string; version?: string }>;
        };
        const sections: Array<{ entries: Array<{ name?: string; version?: string }> | undefined; dev: boolean; section: string }> = [
          { entries: lock.packages, dev: false, section: 'packages' },
          { entries: lock['packages-dev'], dev: true, section: 'packages-dev' },
        ];
        for (const { entries, dev, section } of sections) {
          if (!Array.isArray(entries)) {
            continue;
          }
          for (const pkg of entries) {
            if (pkg && typeof pkg === 'object' && pkg.name) {
              requirements.push({
                id: `req-${Date.now()}-${pkg.name}`,
                ecosystem: 'php',
                type: 'package-dependency',
                name: String(pkg.name),
                versionConstraint: pkg.version ? `==${String(pkg.version).replace(/^v/, '')}` : undefined,
                rawConstraint: pkg.version ? String(pkg.version) : undefined,
                resolvedVersion: pkg.version ? String(pkg.version).replace(/^v/, '') : undefined,
                origin: 'lockfile',
                lockfileSource: 'composer.lock',
                sourceFile,
                sourceSection: section,
                developmentOnly: dev,
                metadata: { type: 'package', locked: true },
              });
            }
          }
        }
      }
    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse composer file: ${err instanceof Error ? err.message : String(err)}`,
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

export class DotNetRequirementParser implements RequirementParser {
  readonly ecosystem = 'dotnet';
  readonly supportedFormats = [
    '*.csproj',
    '*.fsproj',
    '*.vbproj',
    '*.sln',
    '*.slnx',
    'packages.config',
    'global.json',
    'Directory.Packages.props',
    'Directory.Build.props',
    'Directory.Build.targets',
    'nuget.config',
  ];

  canParse(fileName: string): boolean {
    const normalized = fileName.toLowerCase();
    return (
      normalized.endsWith('.csproj') ||
      normalized.endsWith('.fsproj') ||
      normalized.endsWith('.vbproj') ||
      normalized.endsWith('.sln') ||
      normalized.endsWith('.slnx') ||
      normalized.endsWith('packages.config') ||
      normalized.endsWith('global.json') ||
      normalized.endsWith('directory.packages.props') ||
      normalized.endsWith('directory.build.props') ||
      normalized.endsWith('directory.build.targets') ||
      normalized.endsWith('nuget.config')
    );
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const fileName = sourceFile.split('/').pop()?.toLowerCase() || '';

      if (
        fileName.endsWith('.csproj') ||
        fileName.endsWith('.fsproj') ||
        fileName.endsWith('.vbproj') ||
        fileName === 'directory.build.props' ||
        fileName === 'directory.build.targets'
      ) {
        this.parseProjectFile(sourceFile, content, requirements);
      } else if (fileName === 'directory.packages.props') {
        this.parseCentralPackages(sourceFile, content, requirements, errors);
      } else if (fileName.endsWith('.sln')) {
        this.parseSolution(sourceFile, content, requirements);
      } else if (fileName.endsWith('.slnx')) {
        this.parseSolutionXml(sourceFile, content, requirements, errors);
      } else if (fileName === 'packages.config') {
        this.parsePackagesConfig(sourceFile, content, requirements, errors);
      } else if (fileName === 'global.json') {
        this.parseGlobalJson(sourceFile, content, requirements, errors);
      } else if (fileName === 'nuget.config') {
        this.parseNugetConfig(sourceFile, content, requirements);
      }
    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse .NET file: ${err instanceof Error ? err.message : String(err)}`,
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

  private parseProjectFile(sourceFile: string, content: string, requirements: ProjectRequirement[]): void {
    const targetFrameworkMatch = content.match(/<TargetFramework>([^<]+)<\/TargetFramework>/);
        if (targetFrameworkMatch && targetFrameworkMatch[1]) {
          requirements.push({
            id: `req-${Date.now()}-target-framework`,
            ecosystem: 'dotnet',
            type: 'runtime-version',
            name: 'dotnet',
            versionConstraint: targetFrameworkMatch[1].trim(),
            rawConstraint: targetFrameworkMatch[1].trim(),
            sourceFile,
            sourceSection: 'TargetFramework',
            metadata: { type: 'target-framework' },
          });
        }

        const targetFrameworksMatch = content.match(/<TargetFrameworks>([^<]+)<\/TargetFrameworks>/);
        if (targetFrameworksMatch && targetFrameworksMatch[1]) {
          const frameworks = targetFrameworksMatch[1].split(';').map(f => f.trim());
          for (const fw of frameworks) {
            requirements.push({
              id: `req-${Date.now()}-tf-${fw}`,
              ecosystem: 'dotnet',
              type: 'runtime-version',
              name: 'dotnet',
              versionConstraint: fw,
              rawConstraint: fw,
              sourceFile,
              sourceSection: 'TargetFrameworks',
              metadata: { type: 'target-framework', multiTarget: true },
            });
          }
        }

        const packageReferenceRegex = /<PackageReference\s+Include\s*=\s*["']([^"']+)["']\s+Version\s*=\s*["']([^"']+)["']/g;
        let match;
        while ((match = packageReferenceRegex.exec(content)) !== null) {
          if (match[1] && match[2]) {
            const name = match[1];
            const version = match[2];
            requirements.push({
              id: `req-${Date.now()}-${name}`,
              ecosystem: 'dotnet',
              type: 'package-dependency',
              name,
              versionConstraint: version,
              rawConstraint: version,
              sourceFile,
              sourceSection: 'PackageReference',
              metadata: { type: 'nuget' },
            });
          }
        }

        const sdkVersionMatch = content.match(/<Sdk\s+Version\s*=\s*["']([^"']+)["']/);
        if (sdkVersionMatch && sdkVersionMatch[1]) {
          requirements.push({
            id: `req-${Date.now()}-dotnet-sdk`,
            ecosystem: 'dotnet',
            type: 'toolchain',
            name: 'dotnet',
            versionConstraint: sdkVersionMatch[1].trim(),
            rawConstraint: sdkVersionMatch[1].trim(),
            sourceFile,
            sourceSection: 'Sdk.Version',
            metadata: { type: 'sdk' },
          });
        }

        const sdkNameMatch = content.match(/<Project\s+Sdk\s*=\s*["']([^"']+)["']/);
        if (sdkNameMatch && sdkNameMatch[1]) {
          const sdkSpec = sdkNameMatch[1].trim();
          const versionMatch = sdkSpec.match(/\/([^/]+)$/);
          requirements.push({
            id: `req-${Date.now()}-project-sdk`,
            ecosystem: 'dotnet',
            type: 'toolchain',
            name: 'dotnet-sdk',
            versionConstraint: versionMatch && versionMatch[1] ? versionMatch[1] : undefined,
            rawConstraint: sdkSpec,
            sourceFile,
            sourceSection: 'Project.Sdk',
            metadata: { type: 'sdk' },
          });
        }
  }

  private parseCentralPackages(
    sourceFile: string,
    content: string,
    requirements: ProjectRequirement[],
    errors: RequirementParseError[]
  ): void {
    try {
      const versionRegex = /<PackageVersion\s+Include\s*=\s*["']([^"']+)["']\s+Version\s*=\s*["']([^"']+)["']/g;
      let match;
      while ((match = versionRegex.exec(content)) !== null) {
        if (match[1] && match[2]) {
          requirements.push({
            id: `req-${Date.now()}-${match[1]}`,
            ecosystem: 'dotnet',
            type: 'package-dependency',
            name: match[1],
            versionConstraint: match[2],
            rawConstraint: match[2],
            sourceFile,
            sourceSection: 'PackageVersion',
            metadata: { type: 'nuget', central: true },
          });
        }
      }
    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse Directory.Packages.props: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PARSE_ERROR',
        severity: 'error',
      });
    }
  }

  private parseSolution(sourceFile: string, content: string, requirements: ProjectRequirement[]): void {
    const projectRegex = /^Project\([^)]*\)\s*=\s*"[^"]*",\s*"([^"]+)"\s*,/gim;
    let match;
    while ((match = projectRegex.exec(content)) !== null) {
      if (match[1]) {
        const projectPath = match[1].replace(/\\/g, '/').trim();
        requirements.push({
          id: `req-${Date.now()}-sln-project`,
          ecosystem: 'dotnet',
          type: 'custom',
          name: `solution project ${projectPath}`,
          sourceFile,
          sourceSection: 'Project()',
          metadata: { type: 'solution-project', projectPath },
        });
      }
    }
  }

  private parseSolutionXml(
    sourceFile: string,
    content: string,
    requirements: ProjectRequirement[],
    errors: RequirementParseError[]
  ): void {
    try {
      const projectRegex = /<Project\s+path\s*=\s*["']([^"']+)["']/gi;
      let match;
      while ((match = projectRegex.exec(content)) !== null) {
        if (match[1]) {
          requirements.push({
            id: `req-${Date.now()}-slnx-project`,
            ecosystem: 'dotnet',
            type: 'custom',
            name: `solution project ${match[1].trim()}`,
            sourceFile,
            sourceSection: 'Project.path',
            metadata: { type: 'solution-project', projectPath: match[1].trim() },
          });
        }
      }
    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse solution file: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PARSE_ERROR',
        severity: 'error',
      });
    }
  }

  private parsePackagesConfig(
    sourceFile: string,
    content: string,
    requirements: ProjectRequirement[],
    errors: RequirementParseError[]
  ): void {
    try {
      const packageRegex = /<package\s+id\s*=\s*["']([^"']+)["']\s+version\s*=\s*["']([^"']+)["']/gi;
      let match;
      while ((match = packageRegex.exec(content)) !== null) {
        if (match[1] && match[2]) {
          requirements.push({
            id: `req-${Date.now()}-${match[1]}`,
            ecosystem: 'dotnet',
            type: 'package-dependency',
            name: match[1],
            versionConstraint: `==${match[2]}`,
            rawConstraint: match[2],
            resolvedVersion: match[2],
            origin: 'lockfile',
            lockfileSource: 'packages.config',
            sourceFile,
            sourceSection: 'package',
            metadata: { type: 'nuget', locked: true, legacy: true },
          });
        }
      }
    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse packages.config: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PARSE_ERROR',
        severity: 'error',
      });
    }
  }

  private parseGlobalJson(
    sourceFile: string,
    content: string,
    requirements: ProjectRequirement[],
    errors: RequirementParseError[]
  ): void {
    try {
      const manifest = JSON.parse(content) as { sdk?: { version?: string; rollForward?: string } };
      if (manifest.sdk?.version) {
        requirements.push({
          id: `req-${Date.now()}-dotnet-sdk`,
          ecosystem: 'dotnet',
          type: 'toolchain',
          name: 'dotnet-sdk',
          versionConstraint: manifest.sdk.version,
          rawConstraint: manifest.sdk.version,
          sourceFile,
          sourceSection: 'sdk.version',
          metadata: {
            type: 'sdk',
            ...(manifest.sdk.rollForward ? { rollForward: manifest.sdk.rollForward } : {}),
          },
        });
      }
      if (manifest.sdk && !manifest.sdk.version) {
        errors.push({
          sourceFile,
          error: 'global.json has an sdk section without a pinned version',
          code: 'PARSE_ERROR',
          severity: 'warning',
        });
      }
    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse global.json: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PARSE_ERROR',
        severity: 'error',
      });
    }
  }

  private parseNugetConfig(sourceFile: string, content: string, requirements: ProjectRequirement[]): void {
    const packageSourceRegex = /<add\s+key\s*=\s*["']([^"']+)["']\s+value\s*=\s*["']([^"']+)["']/g;
    let match;
    while ((match = packageSourceRegex.exec(content)) !== null) {
      if (match[1] && match[2]) {
        requirements.push({
          id: `req-${Date.now()}-nuget-source-${match[1]}`,
          ecosystem: 'dotnet',
          type: 'package-manager',
          name: match[1],
          versionConstraint: undefined,
          rawConstraint: match[2],
          sourceFile,
          sourceSection: 'packageSources',
          metadata: { type: 'nuget-source', url: match[2] },
        });
      }
    }
  }
}