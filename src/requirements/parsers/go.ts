import type { ProjectRequirement, ParsedRequirements, RequirementParseError, RequirementParser } from '../../core/interfaces.js';

function requirementId(name: string): string {
  return `req-${Date.now()}-${name.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 60)}`;
}

export class GoRequirementParser implements RequirementParser {
  readonly ecosystem = 'go';
  readonly supportedFormats = ['go.mod', 'go.work'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const fileName = sourceFile.split('/').pop()?.toLowerCase() || '';
    if (fileName === 'go.work') {
      return this.parseGoWork(sourceFile, content);
    }
    return this.parseGoMod(sourceFile, content);
  }

  private parseGoMod(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];
    const seen = new Set<string>();

    const add = (requirement: ProjectRequirement): void => {
      const key = `${requirement.type}|${requirement.name}|${requirement.versionConstraint ?? ''}|${requirement.sourceSection ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        requirements.push(requirement);
      }
    };

    try {
      const lines = content.split('\n');
      let block: string | undefined;

      for (const rawLine of lines) {
        const withoutComment = rawLine.split('//')[0] ?? '';
        const indirect = /\/\/\s*indirect/.test(rawLine);
        const line = withoutComment.trim();
        if (!line) {
          continue;
        }

        const blockStart = line.match(/^(require|replace|exclude)\s*\($/);
        if (blockStart && blockStart[1]) {
          block = blockStart[1];
          continue;
        }
        if (line === ')') {
          block = undefined;
          continue;
        }

        const goMatch = line.match(/^go\s+(\d+\.\d+(?:\.\d+)?)/);
        if (goMatch && goMatch[1]) {
          add({
            id: requirementId('go'),
            ecosystem: 'go',
            type: 'runtime-version',
            name: 'go',
            versionConstraint: goMatch[1].trim(),
            rawConstraint: goMatch[1].trim(),
            sourceFile,
            sourceSection: 'go directive',
            metadata: { type: 'runtime' },
          });
          continue;
        }

        const toolchainMatch = line.match(/^toolchain\s+(go\d+\.\d+(?:\.\d+)?|\S+)/);
        if (toolchainMatch && toolchainMatch[1]) {
          add({
            id: requirementId('go-toolchain'),
            ecosystem: 'go',
            type: 'toolchain',
            name: 'go',
            versionConstraint: toolchainMatch[1].trim(),
            rawConstraint: toolchainMatch[1].trim(),
            sourceFile,
            sourceSection: 'toolchain directive',
            metadata: { type: 'toolchain' },
          });
          continue;
        }

        const singleRequire = line.match(/^require\s+([^\s]+)\s+([^\s]+)/);
        if (singleRequire && singleRequire[1] && singleRequire[2]) {
          add({
            id: requirementId(singleRequire[1]),
            ecosystem: 'go',
            type: 'package-dependency',
            name: singleRequire[1],
            versionConstraint: singleRequire[2],
            rawConstraint: singleRequire[2],
            origin: indirect ? 'transitive' : 'direct',
            sourceFile,
            sourceSection: 'require directive',
            metadata: { type: 'module', indirect },
          });
          continue;
        }

        const singleReplace = line.match(/^replace\s+([^\s]+)(?:\s+([^\s]+))?\s*=>\s*([^\s]+)(?:\s+([^\s]+))?/);
        if (singleReplace && singleReplace[1] && singleReplace[3]) {
          const from = singleReplace[2] ? `${singleReplace[1]} ${singleReplace[2]}` : singleReplace[1];
          const to = singleReplace[4] ? `${singleReplace[3]} ${singleReplace[4]}` : singleReplace[3];
          add({
            id: requirementId(`replace-${singleReplace[1]}`),
            ecosystem: 'go',
            type: 'custom',
            name: `${singleReplace[1]} (replace)`,
            versionConstraint: to,
            rawConstraint: `${from} => ${to}`,
            sourceFile,
            sourceSection: 'replace directive',
            metadata: { type: 'replace', module: singleReplace[1] },
          });
          continue;
        }

        const singleExclude = line.match(/^exclude\s+([^\s]+)\s+([^\s]+)/);
        if (singleExclude && singleExclude[1] && singleExclude[2]) {
          add({
            id: requirementId(`exclude-${singleExclude[1]}`),
            ecosystem: 'go',
            type: 'custom',
            name: `${singleExclude[1]} (exclude)`,
            versionConstraint: singleExclude[2],
            rawConstraint: `${singleExclude[1]} ${singleExclude[2]}`,
            sourceFile,
            sourceSection: 'exclude directive',
            metadata: { type: 'exclude', module: singleExclude[1] },
          });
          continue;
        }

        if (block === 'require') {
          const depMatch = line.match(/^([^\s]+)\s+([^\s]+)/);
          if (depMatch && depMatch[1] && depMatch[2]) {
            add({
              id: requirementId(depMatch[1]),
              ecosystem: 'go',
              type: 'package-dependency',
              name: depMatch[1],
              versionConstraint: depMatch[2],
              rawConstraint: depMatch[2],
              origin: indirect ? 'transitive' : 'direct',
              sourceFile,
              sourceSection: 'require block',
              metadata: { type: 'module', indirect },
            });
            continue;
          }
        }

        if (block === 'replace') {
          const replaceMatch = line.match(/^([^\s]+)(?:\s+([^\s]+))?\s*=>\s*([^\s]+)(?:\s+([^\s]+))?/);
          if (replaceMatch && replaceMatch[1] && replaceMatch[3]) {
            const from = replaceMatch[2] ? `${replaceMatch[1]} ${replaceMatch[2]}` : replaceMatch[1];
            const to = replaceMatch[4] ? `${replaceMatch[3]} ${replaceMatch[4]}` : replaceMatch[3];
            add({
              id: requirementId(`replace-${replaceMatch[1]}`),
              ecosystem: 'go',
              type: 'custom',
              name: `${replaceMatch[1]} (replace)`,
              versionConstraint: to,
              rawConstraint: `${from} => ${to}`,
              sourceFile,
              sourceSection: 'replace block',
              metadata: { type: 'replace', module: replaceMatch[1] },
            });
            continue;
          }
        }

        if (block === 'exclude') {
          const excludeMatch = line.match(/^([^\s]+)\s+([^\s]+)/);
          if (excludeMatch && excludeMatch[1] && excludeMatch[2]) {
            add({
              id: requirementId(`exclude-${excludeMatch[1]}`),
              ecosystem: 'go',
              type: 'custom',
              name: `${excludeMatch[1]} (exclude)`,
              versionConstraint: excludeMatch[2],
              rawConstraint: `${excludeMatch[1]} ${excludeMatch[2]}`,
              sourceFile,
              sourceSection: 'exclude block',
              metadata: { type: 'exclude', module: excludeMatch[1] },
            });
          }
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

  private parseGoWork(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      let inUseBlock = false;
      for (const rawLine of content.split('\n')) {
        const line = (rawLine.split('//')[0] ?? '').trim();
        if (!line) {
          continue;
        }
        if (/^use\s*\($/.test(line)) {
          inUseBlock = true;
          continue;
        }
        if (inUseBlock && line === ')') {
          inUseBlock = false;
          continue;
        }
        if (inUseBlock) {
          const cleaned = line.trim();
          if (cleaned) {
            requirements.push({
              id: requirementId(`workspace-${cleaned}`),
              ecosystem: 'go',
              type: 'custom',
              name: `workspace module ${cleaned}`,
              sourceFile,
              sourceSection: 'use block',
              metadata: { type: 'workspace-module', module: cleaned },
            });
          }
          continue;
        }
        const goMatch = line.match(/^go\s+(\d+\.\d+(?:\.\d+)?)/);
        if (goMatch && goMatch[1]) {
          requirements.push({
            id: requirementId('go'),
            ecosystem: 'go',
            type: 'runtime-version',
            name: 'go',
            versionConstraint: goMatch[1].trim(),
            rawConstraint: goMatch[1].trim(),
            sourceFile,
            sourceSection: 'go directive',
            metadata: { type: 'runtime', workspace: true },
          });
          continue;
        }
        const useMatch = line.match(/^use\s+(.+)$/);
        if (useMatch && useMatch[1]) {
          for (const module of useMatch[1].split(/\s+/)) {
            const cleaned = module.trim();
            if (cleaned && cleaned !== '(' && cleaned !== ')') {
              requirements.push({
                id: requirementId(`workspace-${cleaned}`),
                ecosystem: 'go',
                type: 'custom',
                name: `workspace module ${cleaned}`,
                sourceFile,
                sourceSection: 'use directive',
                metadata: { type: 'workspace-module', module: cleaned },
              });
            }
          }
        }
      }
    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse go.work: ${err instanceof Error ? err.message : String(err)}`,
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
