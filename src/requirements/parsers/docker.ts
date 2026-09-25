import type { ProjectRequirement, ParsedRequirements, RequirementParseError, RequirementParser } from '../../core/interfaces.js';

export class DockerfileRequirementParser implements RequirementParser {
  readonly ecosystem = 'docker';
  readonly supportedFormats = ['Dockerfile', 'dockerfile', 'Containerfile', 'containerfile'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
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
          const imageSpec = parts[0] || '';
          const imageParts = imageSpec.split(':');
          const imageName = imageParts[0] || '';
          const tag = imageParts[1] || 'latest';

          if (imageName) {
            requirements.push({
              id: `req-${Date.now()}-from-${imageName.replace(/[^a-zA-Z0-9]/g, '-')}`,
              ecosystem: 'docker',
              type: 'container-image',
              name: imageName,
              versionConstraint: tag,
              rawConstraint: imageSpec,
              sourceFile,
              sourceSection: `FROM`,
              metadata: { type: 'base-image' },
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
      let inServices = false;
      let currentService = '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        if (trimmed === 'services:') {
          inServices = true;
          continue;
        }

        if (inServices && trimmed.endsWith(':') && !trimmed.startsWith(' ')) {
          currentService = trimmed.slice(0, -1);
          continue;
        }

        if (currentService && inServices) {
          if (trimmed.startsWith('image:')) {
            const imageMatch = trimmed.match(/image:\s*(.+)/);
            if (imageMatch && imageMatch[1]) {
              const imageSpec = imageMatch[1].trim().replace(/^["']|["']$/g, '');
              const parts = imageSpec.split(':');
              const imageName = parts[0] || '';
              const tag = parts[1] || 'latest';

              if (imageName) {
                requirements.push({
                  id: `req-${Date.now()}-${currentService}-image`,
                  ecosystem: 'docker',
                  type: 'container-image',
                  name: imageName,
                  versionConstraint: tag,
                  rawConstraint: imageSpec,
                  sourceFile,
                  sourceSection: `services.${currentService}.image`,
                  metadata: { service: currentService, type: 'image' },
                });
              }
            }
          } else if (trimmed.startsWith('build:')) {
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