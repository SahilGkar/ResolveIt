import type { ProjectRequirement, ParsedRequirements, RequirementParseError, RequirementParser } from '../../core/interfaces.js';

export class RubyRequirementParser implements RequirementParser {
  readonly ecosystem = 'ruby';
  readonly supportedFormats = ['Gemfile', 'Gemfile.lock', 'gemspec'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
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

          const gemMatch = trimmed.match(/gem\s+['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?/);
          if (gemMatch && gemMatch[1]) {
            const name = gemMatch[1];
            const version = gemMatch[2] || '*';
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
            const groupMatch = trimmed.match(/group\s+[:'](\w+)['"]/);
            if (groupMatch && groupMatch[1]) {
              currentGroup = groupMatch[1];
              inGroup = true;
            }
          } else if (trimmed === 'end' && inGroup) {
            inGroup = false;
            currentGroup = '';
          }
        }
      } else if (fileName === 'gemspec') {
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
        const lock = JSON.parse(content) as { packages?: Array<{ name?: string; version?: string; dev?: boolean }> };
        if (lock.packages && Array.isArray(lock.packages)) {
          for (const pkg of lock.packages) {
            if (pkg && typeof pkg === 'object' && pkg.name) {
              requirements.push({
                id: `req-${Date.now()}-${pkg.name}`,
                ecosystem: 'php',
                type: 'package-dependency',
                name: String(pkg.name),
                versionConstraint: String(pkg.version),
                rawConstraint: String(pkg.version),
                sourceFile,
                sourceSection: 'packages',
                developmentOnly: pkg.dev === true,
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
  readonly supportedFormats = ['*.csproj', '*.sln', 'Directory.Build.props', 'Directory.Build.targets', 'nuget.config'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.some(fmt =>
      fmt.endsWith('.csproj') && fileName.endsWith('.csproj') ||
      fmt.endsWith('.sln') && fileName.endsWith('.sln') ||
      fileName === fmt
    );
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const fileName = sourceFile.split('/').pop()?.toLowerCase() || '';

      if (fileName.endsWith('.csproj') || fileName === 'directory.build.props' || fileName === 'directory.build.targets') {
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
      } else if (fileName === 'nuget.config') {
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
}