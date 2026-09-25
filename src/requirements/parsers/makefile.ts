import type { ProjectRequirement, ParsedRequirements, RequirementParseError, RequirementParser } from '../../core/interfaces.js';
import { formatMatchesAny } from '../projects.js';

export class MakefileRequirementParser implements RequirementParser {
  readonly ecosystem = 'make';
  readonly supportedFormats = ['Makefile', 'makefile', 'GNUmakefile'];

  canParse(fileName: string): boolean {
    return formatMatchesAny(this.supportedFormats, fileName);
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith('#')) continue;

        const compilerMatch = trimmed.match(/^(CC|CXX|FC|CPP)\s*[:?]=?\s*(.+)$/);
        if (compilerMatch && compilerMatch[1] && compilerMatch[2]) {
          requirements.push({
            id: `req-${Date.now()}-${compilerMatch[1].toLowerCase()}`,
            ecosystem: 'make',
            type: 'toolchain',
            name: compilerMatch[1].toLowerCase(),
            versionConstraint: undefined,
            rawConstraint: compilerMatch[2].trim(),
            sourceFile,
            sourceSection: `${compilerMatch[1]} variable`,
            metadata: { type: 'compiler' },
          });
        }

        const flagsMatch = trimmed.match(/^(CFLAGS|CXXFLAGS|LDFLAGS|CPPFLAGS)\s*[:?]=?\s*(.+)$/);
        if (flagsMatch && flagsMatch[1] && flagsMatch[2]) {
          requirements.push({
            id: `req-${Date.now()}-${flagsMatch[1].toLowerCase()}`,
            ecosystem: 'make',
            type: 'custom',
            name: flagsMatch[1].toLowerCase(),
            versionConstraint: undefined,
            rawConstraint: flagsMatch[2].trim(),
            sourceFile,
            sourceSection: `${flagsMatch[1]} variable`,
            metadata: { type: 'flags' },
          });
        }

        const shellMatch = trimmed.match(/^SHELL\s*[:?]=?\s*(.+)$/);
        if (shellMatch && shellMatch[1]) {
          requirements.push({
            id: `req-${Date.now()}-shell`,
            ecosystem: 'make',
            type: 'system-tool',
            name: 'shell',
            versionConstraint: undefined,
            rawConstraint: shellMatch[1].trim(),
            sourceFile,
            sourceSection: 'SHELL variable',
            metadata: { type: 'shell' },
          });
        }

        const tools = ['gcc', 'g++', 'clang', 'clang++', 'make', 'cmake', 'pkg-config', 'ar', 'ld', 'as'];
        for (const tool of tools) {
          if (trimmed.includes(tool)) {
            requirements.push({
              id: `req-${Date.now()}-${tool}`,
              ecosystem: 'make',
              type: 'build-tool',
              name: tool,
              versionConstraint: undefined,
              rawConstraint: undefined,
              sourceFile,
              sourceSection: 'make rule',
              metadata: { type: 'build-tool', detected: true },
            });
          }
        }

        if (trimmed.startsWith('include ') || trimmed.startsWith('-include ')) {
          // Include directive - could be parsed further but not required for Phase 3
        }

        const varMatch = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*[:?]=?\s*(.+)$/);
        if (varMatch && varMatch[1] && varMatch[2]) {
          const varName = varMatch[1];
          const varValue = varMatch[2].trim();

          if (/VERSION|VERSION_|_VERSION/.test(varName) && /^\d+(\.\d+)+/.test(varValue)) {
            requirements.push({
              id: `req-${Date.now()}-${varName.toLowerCase()}`,
              ecosystem: 'make',
              type: 'custom',
              name: varName.toLowerCase(),
              versionConstraint: varValue,
              rawConstraint: varValue,
              sourceFile,
              sourceSection: 'variable assignment',
              metadata: { type: 'version-variable' },
            });
          }
        }
      }

    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse Makefile: ${err instanceof Error ? err.message : String(err)}`,
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