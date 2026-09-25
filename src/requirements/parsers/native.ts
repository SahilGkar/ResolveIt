import type { ProjectRequirement, ParsedRequirements, RequirementParseError, RequirementParser } from '../../core/interfaces.js';

function requirementId(name: string): string {
  return `req-${Date.now()}-${name.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 60)}`;
}

export class MesonRequirementParser implements RequirementParser {
  readonly ecosystem = 'cpp';
  readonly supportedFormats = ['meson.build'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const projectMatch = content.match(/project\s*\(([\s\S]*?)\)/);
      if (projectMatch && projectMatch[1]) {
        const args = projectMatch[1];
        const versionMatch = args.match(/version\s*:\s*['"]([^'"]+)['"]/);
        if (versionMatch && versionMatch[1]) {
          requirements.push({
            id: requirementId('meson-project-version'),
            ecosystem: 'cpp',
            type: 'custom',
            name: 'project',
            versionConstraint: versionMatch[1].trim(),
            rawConstraint: versionMatch[1].trim(),
            sourceFile,
            sourceSection: 'project().version',
            metadata: { type: 'project-version', buildSystem: 'meson' },
          });
        }
        const mesonVersionMatch = args.match(/meson_version\s*:\s*['"]([^'"]+)['"]/);
        if (mesonVersionMatch && mesonVersionMatch[1]) {
          requirements.push({
            id: requirementId('meson-version'),
            ecosystem: 'cpp',
            type: 'build-tool',
            name: 'meson',
            versionConstraint: mesonVersionMatch[1].trim(),
            rawConstraint: mesonVersionMatch[1].trim(),
            sourceFile,
            sourceSection: 'project().meson_version',
            metadata: { type: 'build-tool', buildSystem: 'meson' },
          });
        }
        const stdMatch = args.match(/default_options\s*:\s*\[[^\]]*?['"]cpp_std=([^'"]+)['"]/);
        if (stdMatch && stdMatch[1]) {
          requirements.push({
            id: requirementId('meson-cpp-std'),
            ecosystem: 'cpp',
            type: 'language-version',
            name: 'c++',
            versionConstraint: stdMatch[1].trim().replace(/^c\+\+/, ''),
            rawConstraint: stdMatch[1].trim(),
            sourceFile,
            sourceSection: 'project().default_options',
            metadata: { type: 'language-standard', buildSystem: 'meson' },
          });
        }
      }

      const dependencyRegex = /dependency\s*\(\s*['"]([^'"]+)['"]([\s\S]*?)\)/g;
      let match;
      while ((match = dependencyRegex.exec(content)) !== null) {
        if (match[1] && match[2] !== undefined) {
          const name = match[1];
          const args = match[2];
          const versionMatch = args.match(/version\s*:\s*(?:\[[^\]]*?\]|['"]([^'"]+)['"])/);
          const rawVersion = versionMatch && versionMatch[1] ? versionMatch[1].trim() : undefined;
          const fallbackMatch = args.match(/fallback\s*:\s*\[[^\]]*?['"]([^'"]+)['"]/);
          requirements.push({
            id: requirementId(name),
            ecosystem: 'cpp',
            type: 'package-dependency',
            name,
            versionConstraint: rawVersion,
            rawConstraint: rawVersion,
            sourceFile,
            sourceSection: 'dependency()',
            metadata: {
              type: 'package',
              buildSystem: 'meson',
              ...(fallbackMatch && fallbackMatch[1] ? { fallback: fallbackMatch[1].trim() } : {}),
            },
          });
        }
      }
    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse meson.build: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PARSE_ERROR',
        severity: 'error',
      });
    }

    return { projectId: 'unknown', sourceFiles: [sourceFile], requirements, parseErrors: errors };
  }
}

export class ConanRequirementParser implements RequirementParser {
  readonly ecosystem = 'cpp';
  readonly supportedFormats = ['conanfile.txt', 'conanfile.py'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const fileName = sourceFile.split('/').pop()?.toLowerCase() || '';

      if (fileName === 'conanfile.txt') {
        let section = '';
        for (const rawLine of content.split('\n')) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) {
            continue;
          }
          const sectionMatch = line.match(/^\[(.+)\]$/);
          if (sectionMatch && sectionMatch[1]) {
            section = sectionMatch[1].toLowerCase();
            continue;
          }
          if ((section === 'requires' || section === 'tool_requires') && !line.startsWith('[')) {
            const depMatch = line.match(/^([^#\s]+)(?:\s*#.*)?$/);
            if (depMatch && depMatch[1]) {
              const spec = depMatch[1].trim();
              const atIndex = spec.lastIndexOf('/');
              const name = atIndex > 0 ? spec.slice(0, atIndex) : spec;
              const version = atIndex > 0 ? spec.slice(atIndex + 1) : undefined;
              requirements.push({
                id: requirementId(name),
                ecosystem: 'cpp',
                type: section === 'tool_requires' ? 'build-tool' : 'package-dependency',
                name,
                versionConstraint: version,
                rawConstraint: spec,
                sourceFile,
                sourceSection: `conanfile[${section}]`,
                metadata: { type: 'package', buildSystem: 'conan' },
              });
            }
          }
        }
      } else {
        const requiresRegex = /requires\s*=\s*(?:["']([^"']+)["']|\[([\s\S]*?)\])/g;
        let match;
        while ((match = requiresRegex.exec(content)) !== null) {
          const specs: string[] = [];
          if (match[1]) {
            specs.push(match[1]);
          }
          if (match[2]) {
            for (const item of match[2].split(',')) {
              const cleaned = item.trim().replace(/^["']|["']$/g, '');
              if (cleaned) {
                specs.push(cleaned);
              }
            }
          }
          for (const spec of specs) {
            const atIndex = spec.lastIndexOf('/');
            const name = atIndex > 0 ? spec.slice(0, atIndex) : spec;
            const version = atIndex > 0 ? spec.slice(atIndex + 1) : undefined;
            requirements.push({
              id: requirementId(name),
              ecosystem: 'cpp',
              type: 'package-dependency',
              name,
              versionConstraint: version,
              rawConstraint: spec,
              sourceFile,
              sourceSection: 'conanfile.requires',
              metadata: { type: 'package', buildSystem: 'conan' },
            });
          }
        }
        if (requirements.length === 0) {
          errors.push({
            sourceFile,
            error: 'conanfile.py uses dynamic declarations that could not be statically resolved',
            code: 'DYNAMIC_DECLARATION',
            severity: 'warning',
          });
        }
      }
    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse conanfile: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PARSE_ERROR',
        severity: 'error',
      });
    }

    return { projectId: 'unknown', sourceFiles: [sourceFile], requirements, parseErrors: errors };
  }
}

export class VcpkgRequirementParser implements RequirementParser {
  readonly ecosystem = 'cpp';
  readonly supportedFormats = ['vcpkg.json'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const manifest = JSON.parse(content) as {
        dependencies?: Array<string | { name?: string; version?: string; 'version>='?: string }>;
        'builtin-baseline'?: string;
      };

      if (manifest['builtin-baseline']) {
        requirements.push({
          id: requirementId('vcpkg-baseline'),
          ecosystem: 'cpp',
          type: 'custom',
          name: 'vcpkg-baseline',
          versionConstraint: String(manifest['builtin-baseline']),
          rawConstraint: String(manifest['builtin-baseline']),
          sourceFile,
          sourceSection: 'builtin-baseline',
          metadata: { type: 'baseline', buildSystem: 'vcpkg' },
        });
      }

      if (Array.isArray(manifest.dependencies)) {
        for (const dep of manifest.dependencies) {
          if (typeof dep === 'string') {
            requirements.push({
              id: requirementId(dep),
              ecosystem: 'cpp',
              type: 'package-dependency',
              name: dep,
              sourceFile,
              sourceSection: 'dependencies',
              metadata: { type: 'package', buildSystem: 'vcpkg' },
            });
          } else if (dep && typeof dep === 'object' && dep.name) {
            const version = dep.version ?? dep['version>='];
            requirements.push({
              id: requirementId(dep.name),
              ecosystem: 'cpp',
              type: 'package-dependency',
              name: dep.name,
              versionConstraint: version,
              rawConstraint: version,
              sourceFile,
              sourceSection: 'dependencies',
              metadata: { type: 'package', buildSystem: 'vcpkg' },
            });
          }
        }
      }
    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse vcpkg.json: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PARSE_ERROR',
        severity: 'error',
      });
    }

    return { projectId: 'unknown', sourceFiles: [sourceFile], requirements, parseErrors: errors };
  }
}
