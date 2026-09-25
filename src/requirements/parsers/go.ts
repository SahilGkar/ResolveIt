import type { ProjectRequirement, ParsedRequirements, RequirementParseError, RequirementParser } from '../../core/interfaces.js';

export class GoRequirementParser implements RequirementParser {
  readonly ecosystem = 'go';
  readonly supportedFormats = ['go.mod'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const lines = content.split('\n');

      // Check go version
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('go ')) {
          const versionMatch = trimmed.match(/go\s+(\d+\.\d+(?:\.\d+)?)/);
          if (versionMatch && versionMatch[1]) {
            requirements.push({
              id: `req-${Date.now()}-go`,
              ecosystem: 'go',
              type: 'runtime-version',
              name: 'go',
              versionConstraint: versionMatch[1].trim(),
              rawConstraint: versionMatch[1].trim(),
              sourceFile,
              sourceSection: 'go directive',
              metadata: { type: 'runtime' },
            });
          }
        }
      }

      // Check toolchain
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('toolchain ')) {
          const toolchainMatch = trimmed.match(/toolchain\s+(go\d+\.\d+(?:\.\d+)?)/);
          if (toolchainMatch && toolchainMatch[1]) {
            requirements.push({
              id: `req-${Date.now()}-go-toolchain`,
              ecosystem: 'go',
              type: 'toolchain',
              name: 'go',
              versionConstraint: toolchainMatch[1].trim(),
              rawConstraint: toolchainMatch[1].trim(),
              sourceFile,
              sourceSection: 'toolchain directive',
              metadata: { type: 'toolchain' },
            });
          }
        }
      }

      // Parse require block
      const requireBlockMatch = content.match(/require\s*\(([\s\S]*?)\)/);
      if (requireBlockMatch && requireBlockMatch[1]) {
        const blockContent = requireBlockMatch[1];
        const depLines = blockContent.split('\n');
        for (const depLine of depLines) {
          const trimmed = depLine.trim();
          if (!trimmed || trimmed.startsWith('//')) continue;

          const depMatch = trimmed.match(/^([^\s]+)\s+([^\s]+)/);
          if (depMatch && depMatch[1] && depMatch[2]) {
            requirements.push({
              id: `req-${Date.now()}-${depMatch[1]}`,
              ecosystem: 'go',
              type: 'package-dependency',
              name: depMatch[1],
              versionConstraint: depMatch[2],
              rawConstraint: depMatch[2],
              sourceFile,
              sourceSection: 'require block',
              metadata: { type: 'module' },
            });
          }
        }
      }

      // Parse single require directives
      const singleRequireRegex = /require\s+([^\s]+)\s+([^\s]+)/g;
      let match;
      while ((match = singleRequireRegex.exec(content)) !== null) {
        if (match[1] && match[2]) {
          requirements.push({
            id: `req-${Date.now()}-${match[1]}`,
            ecosystem: 'go',
            type: 'package-dependency',
            name: match[1],
            versionConstraint: match[2],
            rawConstraint: match[2],
            sourceFile,
            sourceSection: 'require directive',
            metadata: { type: 'module' },
          });
        }
      }

    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse go.mod: ${err instanceof Error ? err.message : String(err)}`,
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