import type { ProjectRequirement, ParsedRequirements, RequirementParseError, RequirementParser } from '../../core/interfaces.js';

function requirementId(name: string): string {
  return `req-${Date.now()}-${name.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 60)}`;
}

export interface Pep508Dependency {
  readonly name: string;
  readonly constraint: string;
  readonly marker?: string;
}

export function parsePep508(line: string): Pep508Dependency | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return undefined;
  }
  const noComment = trimmed.split('#')[0]?.trim() ?? '';
  if (!noComment) {
    return undefined;
  }
  const markerSplit = noComment.split(';');
  const spec = (markerSplit[0] ?? '').trim();
  const marker = markerSplit.length > 1 ? markerSplit.slice(1).join(';').trim() : undefined;
  const match = spec.match(/^([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\[([^\]]*)\])?\s*(\(?\s*[=<>!~][^;]*?\)?)?$/);
  if (!match || !match[1]) {
    return undefined;
  }
  let constraint = (match[3] ?? '').trim();
  if (constraint.startsWith('(') && constraint.endsWith(')')) {
    constraint = constraint.slice(1, -1).trim();
  }
  return {
    name: match[1],
    constraint: constraint || '*',
    ...(marker ? { marker } : {}),
  };
}

function packageDependency(
  name: string,
  versionConstraint: string | undefined,
  sourceFile: string,
  sourceSection: string,
  developmentOnly: boolean,
  scope: string,
  extras?: { marker?: string; optional?: boolean }
): ProjectRequirement {
  return {
    id: requirementId(name),
    ecosystem: 'python',
    type: 'package-dependency',
    name,
    versionConstraint,
    rawConstraint: versionConstraint,
    sourceFile,
    sourceSection,
    optional: extras?.optional ?? false,
    developmentOnly,
    metadata: {
      scope,
      ...(extras?.marker ? { environmentMarker: extras.marker } : {}),
    },
  };
}

export class PythonRequirementParser implements RequirementParser {
  readonly ecosystem = 'python';
  readonly supportedFormats = [
    'requirements.txt',
    'requirements-*.txt',
    'requirements/*.txt',
    'pyproject.toml',
    'setup.py',
    'setup.cfg',
    'Pipfile',
    'Pipfile.lock',
    'poetry.lock',
    'uv.lock',
  ];

  canParse(fileName: string): boolean {
    const normalized = fileName.toLowerCase();
    const base = normalized.split('/').pop() ?? '';
    if (['requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg', 'pipfile', 'pipfile.lock', 'poetry.lock', 'uv.lock'].includes(base)) {
      return true;
    }
    if (/^requirements-.*\.txt$/.test(base)) {
      return true;
    }
    return normalized.includes('/requirements/') && base.endsWith('.txt');
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const normalized = sourceFile.toLowerCase();
    const fileName = normalized.split('/').pop() || '';

    if (
      fileName === 'requirements.txt' ||
      /^requirements-.*\.txt$/.test(fileName) ||
      (normalized.includes('/requirements/') && fileName.endsWith('.txt'))
    ) {
      return this.parseRequirementsTxt(sourceFile, content);
    }

    if (fileName === 'pyproject.toml') {
      return this.parsePyprojectToml(sourceFile, content);
    }

    if (fileName === 'setup.cfg') {
      return this.parseSetupCfg(sourceFile, content);
    }

    if (fileName === 'setup.py') {
      return this.parseSetupPy(sourceFile, content);
    }

    if (fileName === 'pipfile') {
      return this.parsePipfile(sourceFile, content);
    }

    if (fileName === 'pipfile.lock') {
      return this.parsePipfileLock(sourceFile, content);
    }

    if (fileName === 'poetry.lock' || fileName === 'uv.lock') {
      return this.parseTomlLock(sourceFile, content, fileName === 'poetry.lock' ? 'poetry-lock' : 'uv-lock');
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
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const currentLine = lines[i];
      if (!currentLine) {
        continue;
      }
      const line = currentLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('-')) {
        continue;
      }
      const parsed = parsePep508(line);
      if (parsed) {
        requirements.push(
          packageDependency(parsed.name, parsed.constraint, sourceFile, 'requirements.txt', false, 'production', {
            marker: parsed.marker,
          })
        );
      } else {
        errors.push({
          sourceFile,
          error: `Could not parse requirement line: ${line}`,
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
      let section = '';
      let inProjectDependenciesArray = false;
      let currentOptionalSection = '';

      const pep621Runtime = (value: string): void => {
        const cleaned = value.split(';')[0]?.trim() ?? '';
        if (!cleaned) {
          return;
        }
        requirements.push({
          id: requirementId('python-runtime'),
          ecosystem: 'python',
          type: 'runtime-version',
          name: 'python',
          versionConstraint: cleaned,
          rawConstraint: value.trim(),
          sourceFile,
          sourceSection: 'project.requires-python',
          metadata: { type: 'runtime' },
        });
      };

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
          continue;
        }

        const sectionMatch = line.match(/^\[([^\]]+)\]$/);
        if (sectionMatch && sectionMatch[1]) {
          section = sectionMatch[1].trim();
          inProjectDependenciesArray = false;
          currentOptionalSection = '';
          continue;
        }

        if (section === 'project') {
          const requiresMatch = line.match(/^requires-python\s*=\s*["']([^"']+)["']/);
          if (requiresMatch && requiresMatch[1]) {
            pep621Runtime(requiresMatch[1]);
            continue;
          }
          if (/^dependencies\s*=\s*\[/.test(line)) {
            inProjectDependenciesArray = true;
            const inline = line.match(/^dependencies\s*=\s*\[(.*)\]\s*$/);
            if (inline && inline[1] !== undefined) {
              this.parsePep621Array(inline[1], sourceFile, 'project.dependencies', false, requirements);
              inProjectDependenciesArray = false;
            }
            continue;
          }
        }

        if (inProjectDependenciesArray) {
          if (line === ']') {
            inProjectDependenciesArray = false;
            continue;
          }
          const itemMatch = line.match(/^"([^"]+)"\s*,?\s*(?:#.*)?$/) ?? line.match(/^'([^']+)'\s*,?\s*(?:#.*)?$/);
          if (itemMatch && itemMatch[1]) {
            const parsed = parsePep508(itemMatch[1]);
            if (parsed) {
              requirements.push(
                packageDependency(parsed.name, parsed.constraint, sourceFile, 'project.dependencies', false, 'production', {
                  marker: parsed.marker,
                })
              );
            }
            continue;
          }
        }

        if (section === 'project.optional-dependencies') {
          const groupMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*\[/);
          if (groupMatch && groupMatch[1]) {
            const inline = line.match(/^[A-Za-z0-9_.-]+\s*=\s*\[(.*)\]\s*$/);
            if (inline && inline[1] !== undefined) {
              this.parsePep621Array(
                inline[1],
                sourceFile,
                `project.optional-dependencies.${groupMatch[1]}`,
                true,
                requirements
              );
            } else {
              currentOptionalSection = groupMatch[1];
            }
            continue;
          }
          const itemMatch = line.match(/^"([^"]+)"\s*,?\s*(?:#.*)?$/) ?? line.match(/^'([^']+)'\s*,?\s*(?:#.*)?$/);
          if (itemMatch && itemMatch[1]) {
            const parsed = parsePep508(itemMatch[1]);
            if (parsed) {
              const group = currentOptionalSection || 'optional';
              requirements.push(
                packageDependency(parsed.name, parsed.constraint, sourceFile, `project.optional-dependencies.${group}`, true, 'optional', {
                  marker: parsed.marker,
                  optional: true,
                })
              );
            }
            continue;
          }
        }

        if (section === 'tool.poetry.dependencies' || section.startsWith('tool.poetry.group.')) {
          const isDev = section.includes('.group.') && /dev|test/i.test(section);
          const poetryMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
          if (poetryMatch && poetryMatch[1] && poetryMatch[2] !== undefined) {
            const name = poetryMatch[1];
            if (name.toLowerCase() === 'python') {
              const versionMatch = poetryMatch[2].match(/["']([^"']+)["']/);
              if (versionMatch && versionMatch[1]) {
                requirements.push({
                  id: requirementId('python-runtime'),
                  ecosystem: 'python',
                  type: 'runtime-version',
                  name: 'python',
                  versionConstraint: versionMatch[1],
                  rawConstraint: versionMatch[1],
                  sourceFile,
                  sourceSection: `${section}.python`,
                  metadata: { type: 'runtime', buildTool: 'poetry' },
                });
              }
              continue;
            }
            const constraint = this.poetryConstraint(poetryMatch[2]);
            requirements.push(
              packageDependency(name, constraint, sourceFile, section, isDev, isDev ? 'development' : 'production')
            );
            continue;
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

  private parsePep621Array(
    inline: string,
    sourceFile: string,
    section: string,
    developmentOnly: boolean,
    requirements: ProjectRequirement[]
  ): void {
    const items = inline.match(/"[^"]*"|'[^']*'/g) ?? [];
    for (const item of items) {
      const parsed = parsePep508(item.slice(1, -1));
      if (parsed) {
        requirements.push(
          packageDependency(parsed.name, parsed.constraint, sourceFile, section, developmentOnly, developmentOnly ? 'optional' : 'production', {
            marker: parsed.marker,
            optional: developmentOnly,
          })
        );
      }
    }
  }

  private poetryConstraint(raw: string): string {
    const quoted = raw.match(/["']([^"']+)["']/);
    if (quoted && quoted[1]) {
      return quoted[1].trim();
    }
    if (/^\{[^}]*version\s*=\s*["']([^"']+)["']/.test(raw)) {
      const versionMatch = raw.match(/version\s*=\s*["']([^"']+)["']/);
      if (versionMatch && versionMatch[1]) {
        return versionMatch[1].trim();
      }
    }
    return '*';
  }

  private parseSetupCfg(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const lines = content.split('\n');
      let section = '';
      let inInstallRequires = false;

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) {
          continue;
        }
        const sectionMatch = line.match(/^\[(.+)\]$/);
        if (sectionMatch && sectionMatch[1]) {
          section = sectionMatch[1].trim().toLowerCase();
          inInstallRequires = false;
          continue;
        }
        if (section === 'options') {
          const pythonMatch = line.match(/^python_requires\s*=\s*(.+)$/i);
          if (pythonMatch && pythonMatch[1]) {
            requirements.push({
              id: requirementId('python-runtime'),
              ecosystem: 'python',
              type: 'runtime-version',
              name: 'python',
              versionConstraint: pythonMatch[1].trim(),
              rawConstraint: pythonMatch[1].trim(),
              sourceFile,
              sourceSection: 'options.python_requires',
              metadata: { type: 'runtime' },
            });
            continue;
          }
          if (/^install_requires\s*=?\s*$/i.test(line)) {
            inInstallRequires = true;
            continue;
          }
        }
        if (inInstallRequires && section === 'options') {
          if (/^\w+\s*=/.test(line)) {
            inInstallRequires = false;
            continue;
          }
          const parsed = parsePep508(line);
          if (parsed) {
            requirements.push(
              packageDependency(parsed.name, parsed.constraint, sourceFile, 'options.install_requires', false, 'production', {
                marker: parsed.marker,
              })
            );
          }
        }
      }
    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse setup.cfg: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PARSE_ERROR',
        severity: 'error',
      });
    }

    return { projectId: 'unknown', sourceFiles: [sourceFile], requirements, parseErrors: errors };
  }

  private parseSetupPy(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    const literalMatch = content.match(/install_requires\s*=\s*\[([\s\S]*?)\]/);
    if (literalMatch && literalMatch[1] !== undefined) {
      const items = literalMatch[1].match(/"[^"]*"|'[^']*'/g) ?? [];
      if (items.length === 0) {
        errors.push({
          sourceFile,
          error: 'setup.py install_requires is empty or uses dynamic declarations that could not be statically resolved',
          code: 'DYNAMIC_DECLARATION',
          severity: 'warning',
        });
      }
      for (const item of items) {
        const parsed = parsePep508(item.slice(1, -1));
        if (parsed) {
          requirements.push(
            packageDependency(parsed.name, parsed.constraint, sourceFile, 'setup.install_requires', false, 'production', {
              marker: parsed.marker,
            })
          );
        }
      }
    } else if (/install_requires/.test(content)) {
      errors.push({
        sourceFile,
        error: 'setup.py uses dynamic declarations that could not be statically resolved; setup.py is never executed',
        code: 'DYNAMIC_DECLARATION',
        severity: 'warning',
      });
    }

    const pythonMatch = content.match(/python_requires\s*=\s*["']([^"']+)["']/);
    if (pythonMatch && pythonMatch[1]) {
      requirements.push({
        id: requirementId('python-runtime'),
        ecosystem: 'python',
        type: 'runtime-version',
        name: 'python',
        versionConstraint: pythonMatch[1],
        rawConstraint: pythonMatch[1],
        sourceFile,
        sourceSection: 'setup.python_requires',
        metadata: { type: 'runtime' },
      });
    }

    return { projectId: 'unknown', sourceFiles: [sourceFile], requirements, parseErrors: errors };
  }

  private parsePipfile(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      let section = '';
      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
          continue;
        }
        const sectionMatch = line.match(/^\[([^\]]+)\]$/);
        if (sectionMatch && sectionMatch[1]) {
          section = sectionMatch[1].trim().toLowerCase();
          continue;
        }
        if (section === 'packages' || section === 'dev-packages') {
          const entryMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
          if (entryMatch && entryMatch[1] && entryMatch[2] !== undefined) {
            const constraint = this.pipfileConstraint(entryMatch[2]);
            requirements.push(
              packageDependency(
                entryMatch[1],
                constraint,
                sourceFile,
                `Pipfile.${section}`,
                section === 'dev-packages',
                section === 'dev-packages' ? 'development' : 'production'
              )
            );
          }
        }
        if (section === 'requires') {
          const pythonMatch = line.match(/^python_version\s*=\s*["']([^"']+)["']/);
          if (pythonMatch && pythonMatch[1]) {
            requirements.push({
              id: requirementId('python-runtime'),
              ecosystem: 'python',
              type: 'runtime-version',
              name: 'python',
              versionConstraint: `==${pythonMatch[1]}`,
              rawConstraint: pythonMatch[1],
              sourceFile,
              sourceSection: 'requires.python_version',
              metadata: { type: 'runtime' },
            });
          }
        }
      }
    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse Pipfile: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PARSE_ERROR',
        severity: 'error',
      });
    }

    return { projectId: 'unknown', sourceFiles: [sourceFile], requirements, parseErrors: errors };
  }

  private pipfileConstraint(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed === '*') {
      return '*';
    }
    const quoted = trimmed.match(/^["']([^"']+)["']$/);
    if (quoted && quoted[1]) {
      return quoted[1].trim();
    }
    const versionMatch = trimmed.match(/version\s*=\s*["']([^"']+)["']/);
    if (versionMatch && versionMatch[1]) {
      return versionMatch[1].trim();
    }
    return '*';
  }

  private parsePipfileLock(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const lock = JSON.parse(content) as {
        default?: Record<string, { version?: string }>;
        develop?: Record<string, { version?: string }>;
      };
      const sections: Array<{ entries: Record<string, { version?: string }> | undefined; dev: boolean; section: string }> = [
        { entries: lock.default, dev: false, section: 'default' },
        { entries: lock.develop, dev: true, section: 'develop' },
      ];
      for (const { entries, dev, section } of sections) {
        if (!entries || typeof entries !== 'object') {
          continue;
        }
        for (const [name, entry] of Object.entries(entries)) {
          requirements.push({
            id: requirementId(name),
            ecosystem: 'python',
            type: 'package-dependency',
            name,
            versionConstraint: entry?.version?.replace(/^==/, ''),
            rawConstraint: entry?.version,
            resolvedVersion: entry?.version?.replace(/^==/, ''),
            origin: 'lockfile',
            lockfileSource: 'Pipfile.lock',
            sourceFile,
            sourceSection: `Pipfile.lock.${section}`,
            developmentOnly: dev,
            metadata: { scope: dev ? 'development' : 'production', locked: true },
          });
        }
      }
    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse Pipfile.lock: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PARSE_ERROR',
        severity: 'error',
      });
    }

    return { projectId: 'unknown', sourceFiles: [sourceFile], requirements, parseErrors: errors };
  }

  private parseTomlLock(sourceFile: string, content: string, lockKind: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const lines = content.split('\n');
      let currentName: string | undefined;
      let currentVersion: string | undefined;
      let inPackage = false;

      const flush = (): void => {
        if (currentName && currentVersion) {
          requirements.push({
            id: requirementId(currentName),
            ecosystem: 'python',
            type: 'package-dependency',
            name: currentName,
            versionConstraint: `==${currentVersion}`,
            rawConstraint: currentVersion,
            resolvedVersion: currentVersion,
            origin: 'lockfile',
            lockfileSource: lockKind,
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
          inPackage = true;
          continue;
        }
        if (line.startsWith('[')) {
          flush();
          inPackage = false;
          continue;
        }
        if (!inPackage || !line || line.startsWith('#')) {
          continue;
        }
        const nameMatch = line.match(/^name\s*=\s*["']([^"']+)["']/);
        if (nameMatch && nameMatch[1]) {
          currentName = nameMatch[1];
          continue;
        }
        const versionMatch = line.match(/^version\s*=\s*["']([^"']+)["']/);
        if (versionMatch && versionMatch[1]) {
          currentVersion = versionMatch[1];
        }
      }
      flush();

      if (requirements.length === 0) {
        errors.push({
          sourceFile,
          error: `${sourceFile.split('/').pop()} has no recognizable [[package]] entries`,
          code: 'PARSE_ERROR',
          severity: 'warning',
        });
      }
    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse lockfile: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PARSE_ERROR',
        severity: 'error',
      });
    }

    return { projectId: 'unknown', sourceFiles: [sourceFile], requirements, parseErrors: errors };
  }
}
