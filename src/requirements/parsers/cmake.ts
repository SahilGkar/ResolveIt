import type { ProjectRequirement, ParsedRequirements, RequirementParseError, RequirementParser } from '../../core/interfaces.js';

export class CMakeRequirementParser implements RequirementParser {
  readonly ecosystem = 'cpp';
  readonly supportedFormats = ['CMakeLists.txt'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const cmakeMinMatch = content.match(/cmake_minimum_required\s*\(\s*VERSION\s+([^)\s]+)/i);
      if (cmakeMinMatch && cmakeMinMatch[1]) {
        requirements.push({
          id: `req-${Date.now()}-cmake`,
          ecosystem: 'cpp',
          type: 'build-tool',
          name: 'cmake',
          versionConstraint: cmakeMinMatch[1].trim(),
          rawConstraint: cmakeMinMatch[1].trim(),
          sourceFile,
          sourceSection: 'cmake_minimum_required',
          metadata: { type: 'build-tool' },
        });
      }

      const projectMatch = content.match(/project\s*\(\s*([^)\s]+)(?:\s+VERSION\s+([^)\s]+))?/i);
      if (projectMatch && projectMatch[2]) {
        requirements.push({
          id: `req-${Date.now()}-project-version`,
          ecosystem: 'cpp',
          type: 'custom',
          name: 'project',
          versionConstraint: projectMatch[2].trim(),
          rawConstraint: projectMatch[2].trim(),
          sourceFile,
          sourceSection: 'project()',
          metadata: { type: 'project-version' },
        });
      }

      const cxxStandardMatch = content.match(/set\s*\(\s*CMAKE_CXX_STANDARD\s+(\d+)/i);
      if (cxxStandardMatch && cxxStandardMatch[1]) {
        requirements.push({
          id: `req-${Date.now()}-cxx-standard`,
          ecosystem: 'cpp',
          type: 'language-version',
          name: 'c++',
          versionConstraint: cxxStandardMatch[1].trim(),
          rawConstraint: cxxStandardMatch[1].trim(),
          sourceFile,
          sourceSection: 'CMAKE_CXX_STANDARD',
          metadata: { type: 'language-standard' },
        });
      }

      const cStandardMatch = content.match(/set\s*\(\s*CMAKE_C_STANDARD\s+(\d+)/i);
      if (cStandardMatch && cStandardMatch[1]) {
        requirements.push({
          id: `req-${Date.now()}-c-standard`,
          ecosystem: 'c',
          type: 'language-version',
          name: 'c',
          versionConstraint: cStandardMatch[1].trim(),
          rawConstraint: cStandardMatch[1].trim(),
          sourceFile,
          sourceSection: 'CMAKE_C_STANDARD',
          metadata: { type: 'language-standard' },
        });
      }

      const findPackageRegex = /find_package\s*\(\s*([^)\s]+)(?:\s+([^)\s]+))?/gi;
      let match;
      while ((match = findPackageRegex.exec(content)) !== null) {
        if (match[1]) {
          const packageName = match[1].trim();
          const version = match[2] ? match[2].trim() : undefined;

          requirements.push({
            id: `req-${Date.now()}-${packageName}`,
            ecosystem: 'cpp',
            type: 'package-dependency',
            name: packageName,
            versionConstraint: version,
            rawConstraint: version,
            sourceFile,
            sourceSection: 'find_package',
            metadata: { type: 'package', buildSystem: 'cmake' },
          });
        }
      }

    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse CMakeLists.txt: ${err instanceof Error ? err.message : String(err)}`,
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