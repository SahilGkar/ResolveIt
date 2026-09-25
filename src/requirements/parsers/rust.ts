import type { ProjectRequirement, ParsedRequirements, RequirementParseError, RequirementParser } from '../../core/interfaces.js';
import { formatMatchesAny } from '../projects.js';

export class RustRequirementParser implements RequirementParser {
  readonly ecosystem = 'rust';
  readonly supportedFormats = ['Cargo.toml', 'Cargo.lock'];

  canParse(fileName: string): boolean {
    return formatMatchesAny(this.supportedFormats, fileName);
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const fileName = sourceFile.split('/').pop()?.toLowerCase() || '';
    if (fileName === 'cargo.lock') {
      return this.parseCargoLock(sourceFile, content);
    }
    return this.parseCargoToml(sourceFile, content);
  }

  private parseCargoLock(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const lines = content.split('\n');
      let currentName: string | undefined;
      let currentVersion: string | undefined;

      const flush = (): void => {
        if (currentName && currentVersion) {
          requirements.push({
            id: `req-${Date.now()}-${currentName}`,
            ecosystem: 'rust',
            type: 'package-dependency',
            name: currentName,
            versionConstraint: `==${currentVersion}`,
            rawConstraint: currentVersion,
            resolvedVersion: currentVersion,
            origin: 'lockfile',
            lockfileSource: 'Cargo.lock',
            sourceFile,
            sourceSection: '[[package]]',
            metadata: { locked: true },
          });
        }
        currentName = undefined;
        currentVersion = undefined;
      };

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line === '[[package]]') {
          flush();
          continue;
        }
        if (line.startsWith('[')) {
          flush();
          continue;
        }
        const nameMatch = line.match(/^name\s*=\s*"([^"]+)"/);
        if (nameMatch && nameMatch[1]) {
          currentName = nameMatch[1];
          continue;
        }
        const versionMatch = line.match(/^version\s*=\s*"([^"]+)"/);
        if (versionMatch && versionMatch[1]) {
          currentVersion = versionMatch[1];
        }
      }
      flush();

      if (requirements.length === 0) {
        errors.push({
          sourceFile,
          error: 'Cargo.lock has no recognizable [[package]] entries',
          code: 'PARSE_ERROR',
          severity: 'warning',
        });
      }
    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse Cargo.lock: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PARSE_ERROR',
        severity: 'error',
      });
    }

    return { projectId: 'unknown', sourceFiles: [sourceFile], requirements, parseErrors: errors };
  }

  private parseCargoToml(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      // Extract rust-version
      const rustVersionMatch = content.match(/rust-version\s*=\s*["']([^"']+)["']/);
      if (rustVersionMatch && rustVersionMatch[1]) {
        requirements.push({
          id: `req-${Date.now()}-rust-version`,
          ecosystem: 'rust',
          type: 'runtime-version',
          name: 'rust',
          versionConstraint: rustVersionMatch[1].trim(),
          rawConstraint: rustVersionMatch[1].trim(),
          sourceFile,
          sourceSection: 'package.rust-version',
          metadata: { type: 'runtime' },
        });
      }

      // Extract edition
      const editionMatch = content.match(/edition\s*=\s*["']([^"']+)["']/);
      if (editionMatch && editionMatch[1]) {
        requirements.push({
          id: `req-${Date.now()}-rust-edition`,
          ecosystem: 'rust',
          type: 'language-version',
          name: 'rust',
          versionConstraint: editionMatch[1].trim(),
          rawConstraint: editionMatch[1].trim(),
          sourceFile,
          sourceSection: 'package.edition',
          metadata: { type: 'edition' },
        });
      }

      // Parse dependencies
      const parseDependencies = (section: string, dev: boolean, build: boolean): void => {
        const sectionRegex = new RegExp(`\\[${section}\\]`, 'i');
        const sectionMatch = content.match(sectionRegex);
        if (!sectionMatch || sectionMatch.index === undefined) return;

        const sectionStart = sectionMatch.index + sectionMatch[0].length;
        const nextSection = content.indexOf('[', sectionStart);
        const sectionContent = nextSection === -1 ? content.slice(sectionStart) : content.slice(sectionStart, nextSection);

        const depRegex = /^([A-Za-z0-9_-]+)\s*=\s*(?:(["'])([^"']+)\2|\{([^}]*)\})/gim;
        let match;
        while ((match = depRegex.exec(sectionContent)) !== null) {
          const name = match[1];
          const inline = match[3];
          const table = match[4];
          if (!name) {
            continue;
          }
          if (table !== undefined) {
            const workspaceRef = /\bworkspace\s*=\s*true/i.test(table);
            const versionMatch = table.match(/version\s*=\s*(["'])([^"']+)\1/);
            const optional = /optional\s*=\s*true/i.test(table);
            if (workspaceRef && !versionMatch) {
              requirements.push({
                id: `req-${Date.now()}-${name}`,
                ecosystem: 'rust',
                type: 'package-dependency',
                name,
                sourceFile,
                sourceSection: section,
                developmentOnly: dev,
                optional,
                metadata: { section, build, inherited: true },
              });
              continue;
            }
            if (versionMatch && versionMatch[2]) {
              requirements.push({
                id: `req-${Date.now()}-${name}`,
                ecosystem: 'rust',
                type: 'package-dependency',
                name,
                versionConstraint: versionMatch[2],
                rawConstraint: versionMatch[2],
                sourceFile,
                sourceSection: section,
                developmentOnly: dev,
                optional,
                metadata: { section, build },
              });
            }
            continue;
          }
          if (inline) {
            requirements.push({
              id: `req-${Date.now()}-${name}`,
              ecosystem: 'rust',
              type: 'package-dependency',
              name,
              versionConstraint: inline,
              rawConstraint: inline,
              sourceFile,
              sourceSection: section,
              developmentOnly: dev,
              optional: false,
              metadata: { section, build },
            });
          }
        }
      };

      parseDependencies('dependencies', false, false);
      parseDependencies('dev-dependencies', true, false);
      parseDependencies('build-dependencies', false, true);

      // Parse target-specific dependencies
      const targetRegex = /\[target\.([^\]]+)\.dependencies\]/g;
      let targetMatch;
      while ((targetMatch = targetRegex.exec(content)) !== null) {
        if (targetMatch[1] && targetMatch.index !== undefined) {
          const target = targetMatch[1];
          const targetStart = targetMatch.index + targetMatch[0].length;
          const nextSection = content.indexOf('[', targetStart);
          const sectionContent = nextSection === -1 ? content.slice(targetStart) : content.slice(targetStart, nextSection);

          const depRegex = /^([A-Za-z0-9_-]+)\s*=\s*(["'])([^"']+)\2/gi;
          let depMatch;
          while ((depMatch = depRegex.exec(sectionContent)) !== null) {
            if (depMatch[1] && depMatch[3]) {
              requirements.push({
                id: `req-${Date.now()}-${depMatch[1]}`,
                ecosystem: 'rust',
                type: 'package-dependency',
                name: depMatch[1],
                versionConstraint: depMatch[3],
                rawConstraint: depMatch[3],
                sourceFile,
                sourceSection: `target.${target}.dependencies`,
                metadata: { target },
              });
            }
          }
        }
      }

      // Parse workspace dependencies
      const workspaceRegex = /\[workspace\.dependencies\]/i;
      const workspaceMatch = content.match(workspaceRegex);
      if (workspaceMatch && workspaceMatch.index !== undefined) {
        const sectionStart = workspaceMatch.index + workspaceMatch[0].length;
        const nextSection = content.indexOf('[', sectionStart);
        const sectionContent = nextSection === -1 ? content.slice(sectionStart) : content.slice(sectionStart, nextSection);

        const depRegex = /^([A-Za-z0-9_-]+)\s*=\s*(?:(["'])([^"']+)\2|\{([^}]*)\})/gim;
        let match;
        while ((match = depRegex.exec(sectionContent)) !== null) {
          const name = match[1];
          const inline = match[3];
          const table = match[4];
          if (!name) {
            continue;
          }
          const tableVersion = table !== undefined ? table.match(/version\s*=\s*(["'])([^"']+)\1/) : undefined;
          const version = inline ?? tableVersion?.[2];
          if (version) {
            requirements.push({
              id: `req-${Date.now()}-${name}`,
              ecosystem: 'rust',
              type: 'package-dependency',
              name,
              versionConstraint: version,
              rawConstraint: version,
              sourceFile,
              sourceSection: 'workspace.dependencies',
              developmentOnly: false,
              optional: false,
              metadata: { section: 'workspace.dependencies' },
            });
          }
        }
      }

      // Parse workspace members
      const membersMatch = content.match(/\[workspace\][\s\S]*?members\s*=\s*\[([\s\S]*?)\]/i);
      if (membersMatch && membersMatch[1]) {
        const members = membersMatch[1].match(/"[^"]+"|'[^']+'/g) ?? [];
        for (const member of members) {
          const cleaned = member.slice(1, -1).trim();
          if (cleaned) {
            requirements.push({
              id: `req-${Date.now()}-member`,
              ecosystem: 'rust',
              type: 'custom',
              name: `workspace member ${cleaned}`,
              sourceFile,
              sourceSection: 'workspace.members',
              metadata: { type: 'workspace-member', member: cleaned },
            });
          }
        }
      }

    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse Cargo.toml: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PARSE_ERROR',
        severity: 'error',
      });
    }

    return { projectId: 'unknown', sourceFiles: [sourceFile], requirements, parseErrors: errors };
  }
}