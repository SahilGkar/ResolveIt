import type { ProjectRequirement, ParsedRequirements, RequirementParseError, RequirementParser } from '../../core/interfaces.js';

export class RustRequirementParser implements RequirementParser {
  readonly ecosystem = 'rust';
  readonly supportedFormats = ['Cargo.toml'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
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

        const depRegex = /^(\w+)\s*=\s*(?:(["'])([^"']+)\2|\{[\s\S]*?version\s*=\s*(["'])([^"']+)\4)/gim;
        let match;
        while ((match = depRegex.exec(sectionContent)) !== null) {
          const name = match[1];
          const version = match[3] || match[5];
          if (name && version) {
            requirements.push({
              id: `req-${Date.now()}-${name}`,
              ecosystem: 'rust',
              type: 'package-dependency',
              name,
              versionConstraint: version,
              rawConstraint: version,
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

          const depRegex = /^(\w+)\s*=\s*(["'])([^"']+)\2/gi;
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

        const depRegex = /^(\w+)\s*=\s*(?:(["'])([^"']+)\2|\{[\s\S]*?version\s*=\s*(["'])([^"']+)\4)/gim;
        let match;
        while ((match = depRegex.exec(sectionContent)) !== null) {
          const name = match[1];
          const version = match[3] || match[5];
          if (name && version) {
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