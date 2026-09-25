import type { ProjectRequirement, ParsedRequirements, RequirementParseError, RequirementParser } from '../../core/interfaces.js';
import { formatMatchesAny } from '../projects.js';

export class DockerfileRequirementParser implements RequirementParser {
  readonly ecosystem = 'docker';
  readonly supportedFormats = ['Dockerfile', 'dockerfile', 'Containerfile', 'containerfile'];

  canParse(fileName: string): boolean {
    return formatMatchesAny(this.supportedFormats, fileName);
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const lines = content.split('\n');
      let i = 0;

      while (i < lines.length) {
        const currentLine = lines[i];
        if (!currentLine) {
          i++;
          continue;
        }
        const line = currentLine.trim();
        if (!line || line.trim().startsWith('#')) {
          i++;
          continue;
        }

        let fullLine = currentLine;
        let j = i;
        while (fullLine.trim().endsWith('\\') && j + 1 < lines.length) {
          j++;
          const nextLine = lines[j];
          if (nextLine) {
            fullLine += ' ' + nextLine.trim();
          }
        }
        i = j + 1;

        const trimmed = fullLine.trim();
        const match = trimmed.match(/^(\w+)\s+(.+)$/);
        if (!match || !match[1] || !match[2]) continue;

        const instruction = match[1].toUpperCase();
        const args = match[2].trim();

        if (instruction === 'FROM') {
          const fromArgs = args;
          const parts = fromArgs.split(/\s+/);
          let platform: string | undefined;
          let imageSpec = '';
          for (let k = 0; k < parts.length; k++) {
            const part = parts[k] ?? '';
            const platformEquals = part.match(/^--platform=(.+)$/);
            if (platformEquals && platformEquals[1]) {
              platform = platformEquals[1];
              continue;
            }
            if (part === '--platform' && k + 1 < parts.length) {
              platform = parts[k + 1];
              k += 1;
              continue;
            }
            if (part.startsWith('--')) {
              continue;
            }
            if (!imageSpec) {
              imageSpec = part;
            }
          }
          const digestSplit = imageSpec.split('@');
          const nameTag = digestSplit[0] ?? '';
          const digest = digestSplit.length > 1 ? digestSplit.slice(1).join('@') : undefined;
          const lastSlash = nameTag.lastIndexOf('/');
          const lastColon = nameTag.lastIndexOf(':');
          const imageName = lastColon > lastSlash ? nameTag.slice(0, lastColon) : nameTag;
          const tag = lastColon > lastSlash ? nameTag.slice(lastColon + 1) : 'latest';

          if (imageName) {
            requirements.push({
              id: `req-${Date.now()}-from-${imageName.replace(/[^a-zA-Z0-9]/g, '-')}`,
              ecosystem: 'docker',
              type: 'container-image',
              name: imageName,
              versionConstraint: digest ? `${tag}@${digest}` : tag,
              rawConstraint: imageSpec,
              sourceFile,
              sourceSection: `FROM`,
              metadata: {
                type: 'base-image',
                ...(digest ? { digest, pinned: true } : {}),
                ...(platform ? { platform } : {}),
              },
            });
          }
        }

        if (instruction === 'ARG' && !args.includes(' ')) {
          const argMatch = args.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:=(.+))?$/);
          if (argMatch && argMatch[1]) {
            requirements.push({
              id: `req-${Date.now()}-arg-${argMatch[1]}`,
              ecosystem: 'docker',
              type: 'custom',
              name: `build arg ${argMatch[1]}`,
              versionConstraint: argMatch[2]?.trim() || undefined,
              rawConstraint: args,
              sourceFile,
              sourceSection: 'ARG',
              metadata: { type: 'build-arg', arg: argMatch[1] },
            });
          }
        }
      }

    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse Dockerfile: ${err instanceof Error ? err.message : String(err)}`,
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

export class DockerComposeRequirementParser implements RequirementParser {
  readonly ecosystem = 'docker';
  readonly supportedFormats = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const lines = content.split('\n');
      let servicesIndent = -1;
      let currentService = '';

      const indentOf = (rawLine: string): number => {
        const match = rawLine.match(/^(\s*)\S/);
        return match && match[1] !== undefined ? match[1].length : -1;
      };

      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        if (trimmed === 'services:' && indentOf(rawLine) === 0) {
          servicesIndent = 0;
          currentService = '';
          continue;
        }

        if (servicesIndent === -1) {
          continue;
        }

        const indent = indentOf(rawLine);
        if (indent <= servicesIndent && trimmed.length > 0) {
          servicesIndent = -1;
          currentService = '';
          continue;
        }

        if (trimmed.endsWith(':') && indent === servicesIndent + 2) {
          currentService = trimmed.slice(0, -1);
          continue;
        }

        if (currentService && indent > servicesIndent + 2) {
          if (trimmed.startsWith('image:')) {
            const imageMatch = trimmed.match(/image:\s*(.+)/);
            if (imageMatch && imageMatch[1]) {
              const imageSpec = imageMatch[1].trim().replace(/^["']|["']$/g, '');
              const digestSplit = imageSpec.split('@');
              const nameTag = digestSplit[0] ?? '';
              const digest = digestSplit.length > 1 ? digestSplit.slice(1).join('@') : undefined;
              const lastSlash = nameTag.lastIndexOf('/');
              const lastColon = nameTag.lastIndexOf(':');
              const imageName = lastColon > lastSlash ? nameTag.slice(0, lastColon) : nameTag;
              const tag = lastColon > lastSlash ? nameTag.slice(lastColon + 1) : 'latest';

              if (imageName) {
                requirements.push({
                  id: `req-${Date.now()}-${currentService}-image`,
                  ecosystem: 'docker',
                  type: 'container-image',
                  name: imageName,
                  versionConstraint: digest ? `${tag}@${digest}` : tag,
                  rawConstraint: imageSpec,
                  sourceFile,
                  sourceSection: `services.${currentService}.image`,
                  metadata: {
                    service: currentService,
                    type: 'image',
                    ...(digest ? { digest, pinned: true } : {}),
                  },
                });
              }
            }
          } else if (trimmed.startsWith('build:')) {
            const buildValue = trimmed.slice('build:'.length).trim();
            if (buildValue) {
              requirements.push({
                id: `req-${Date.now()}-${currentService}-build`,
                ecosystem: 'docker',
                type: 'container-image',
                name: 'build',
                versionConstraint: buildValue.replace(/^["']|["']$/g, ''),
                rawConstraint: buildValue,
                sourceFile,
                sourceSection: `services.${currentService}.build`,
                metadata: { service: currentService, type: 'build' },
              });
            } else {
              requirements.push({
                id: `req-${Date.now()}-${currentService}-build`,
                ecosystem: 'docker',
                type: 'container-image',
                name: 'build',
                rawConstraint: trimmed,
                sourceFile,
                sourceSection: `services.${currentService}.build`,
                metadata: { service: currentService, type: 'build' },
              });
            }
          } else if (trimmed.startsWith('dockerfile:')) {
            const dockerfileMatch = trimmed.match(/dockerfile:\s*(.+)/);
            if (dockerfileMatch && dockerfileMatch[1]) {
              requirements.push({
                id: `req-${Date.now()}-${currentService}-dockerfile`,
                ecosystem: 'docker',
                type: 'container-image',
                name: 'dockerfile',
                rawConstraint: dockerfileMatch[1].trim(),
                sourceFile,
                sourceSection: `services.${currentService}.build.dockerfile`,
                metadata: { service: currentService, type: 'dockerfile' },
              });
            }
          }
        }
      }

    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse docker-compose: ${err instanceof Error ? err.message : String(err)}`,
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