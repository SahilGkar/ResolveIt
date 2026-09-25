import type { ProjectRequirement, ParsedRequirements, RequirementParseError, RequirementParser } from '../../core/interfaces.js';

export class PythonRequirementParser implements RequirementParser {
  readonly ecosystem = 'python';
  readonly supportedFormats = ['requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const fileName = sourceFile.split('/').pop()?.toLowerCase() || '';

    if (fileName === 'requirements.txt') {
      return this.parseRequirementsTxt(sourceFile, content);
    }

    if (fileName === 'pyproject.toml') {
      return this.parsePyprojectToml(sourceFile, content);
    }

    if (fileName === 'setup.py' || fileName === 'setup.cfg') {
      return { projectId: 'unknown', sourceFiles: [sourceFile], requirements: [], parseErrors: [] };
    }

    return {
      projectId: 'unknown',
      sourceFiles: [sourceFile],
      requirements: [],
      parseErrors: [{
        sourceFile,
        error: `Unsupported Python format: ${fileName}`,
        code: 'UNSUPPORTED_FORMAT',
        severity: 'warning',
      }],
    };
  }

  private parseRequirementsTxt(sourceFile: string, content: string): ParsedRequirements {
    const lines = content.split('\n');
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    for (let i = 0; i < lines.length; i++) {
      const currentLine = lines[i];
      if (!currentLine) continue;
      const line = currentLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('-')) continue;

      const parts = line.split('#');
      const requirement = parts[0];
      if (!requirement) continue;
      const trimmed = requirement.trim();
      if (!trimmed) continue;

      const depMatch = trimmed.match(/^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*([=<>!~]=?.*)?$/);
      if (depMatch && depMatch[1]) {
        const name = depMatch[1];
        const constraint = (depMatch[2] || '').trim();
        const versionConstraint = constraint || '*';

        requirements.push({
          id: `req-${Date.now()}-${name}-${i}`,
          ecosystem: 'python',
          type: 'package-dependency',
          name,
          versionConstraint,
          rawConstraint: versionConstraint,
          sourceFile,
          sourceSection: 'requirements.txt',
          optional: false,
          developmentOnly: false,
          metadata: { scope: 'production' },
        });
      } else {
        errors.push({
          sourceFile,
          error: `Could not parse requirement line: ${trimmed}`,
          code: 'PARSE_ERROR',
          severity: 'warning',
        });
      }
    }

    return { projectId: 'unknown', sourceFiles: [sourceFile], requirements, parseErrors: errors };
  }

  private parsePyprojectToml(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const lines = content.split('\n');
      let inDependencies = false;
      let inOptionalDeps = false;
      let currentOptionalSection = '';

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith('[project]')) {
          inDependencies = false;
          inOptionalDeps = false;
        } else if (trimmed === '[project.optional-dependencies]') {
          inOptionalDeps = true;
          inDependencies = true;
        } else if (trimmed.startsWith('[') && !trimmed.startsWith('[project')) {
          inDependencies = false;
          inOptionalDeps = false;
        } else if (trimmed.startsWith('requires-python')) {
          const match = trimmed.match(/requires-python\s*=\s*["']([^"']+)["']/);
          if (match && match[1]) {
            requirements.push({
              id: `req-${Date.now()}-python-runtime`,
              ecosystem: 'python',
              type: 'runtime-version',
              name: 'python',
              versionConstraint: match[1],
              rawConstraint: match[1],
              sourceFile,
              sourceSection: 'project.requires-python',
              metadata: { type: 'runtime' },
            });
          }
        } else if (trimmed.startsWith('dependencies')) {
          inDependencies = true;
        } else if (inOptionalDeps && trimmed.match(/^(\w+)\s*=\s*\[/)) {
          const sectionMatch = trimmed.match(/^(\w+)\s*=\s*\[/);
          if (sectionMatch && sectionMatch[1]) {
            currentOptionalSection = sectionMatch[1];
          }
        } else if (inDependencies && trimmed.includes('=') && !trimmed.startsWith('[')) {
          const depMatch = trimmed.match(/^["']?([a-zA-Z0-9][a-zA-Z0-9._-]*)["']?\s*=\s*["']([^"']+)["']/);
          if (depMatch && depMatch[1] && depMatch[2]) {
            const name = depMatch[1];
            const version = depMatch[2];
            requirements.push({
              id: `req-${Date.now()}-${name}`,
              ecosystem: 'python',
              type: 'package-dependency',
              name,
              versionConstraint: version,
              rawConstraint: version,
              sourceFile,
              sourceSection: inOptionalDeps ? `project.optional-dependencies.${currentOptionalSection}` : 'project.dependencies',
              optional: inOptionalDeps,
              developmentOnly: inOptionalDeps,
              metadata: { scope: inOptionalDeps ? 'optional' : 'production' },
            });
          }
        }
      }
    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse pyproject.toml: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PARSE_ERROR',
        severity: 'error',
      });
    }

    return { projectId: 'unknown', sourceFiles: [sourceFile], requirements, parseErrors: errors };
  }
}