import type { ProjectRequirement, ParsedRequirements, RequirementParseError, RequirementParser } from '../../core/interfaces.js';

function requirementId(name: string): string {
  return `req-${Date.now()}-${name.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 60)}`;
}

function lockedDependency(
  name: string,
  version: string | undefined,
  sourceFile: string,
  sourceSection: string,
  lockfileSource: string,
  developmentOnly: boolean
): ProjectRequirement {
  return {
    id: requirementId(name),
    ecosystem: 'node',
    type: 'package-dependency',
    name,
    versionConstraint: version,
    rawConstraint: version,
    resolvedVersion: version,
    origin: 'lockfile',
    lockfileSource,
    sourceFile,
    sourceSection,
    developmentOnly,
    metadata: { scope: developmentOnly ? 'development' : 'production', locked: true },
  };
}

function parsePackageLock(sourceFile: string, content: string): { requirements: ProjectRequirement[]; errors: RequirementParseError[] } {
  const requirements: ProjectRequirement[] = [];
  const errors: RequirementParseError[] = [];
  const lock = JSON.parse(content) as {
    packages?: Record<string, { version?: string; dev?: boolean }>;
    dependencies?: Record<string, { version?: string; resolved?: string; dev?: boolean }>;
  };

  if (lock.packages && typeof lock.packages === 'object') {
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key || !entry || typeof entry !== 'object') {
        continue;
      }
      const name = key.startsWith('node_modules/')
        ? key.slice('node_modules/'.length).split('node_modules/').pop() ?? key
        : key;
      if (!name) {
        continue;
      }
      requirements.push(
        lockedDependency(name, entry.version, sourceFile, `packages.${key}`, 'package-lock', entry.dev === true)
      );
    }
  } else if (lock.dependencies && typeof lock.dependencies === 'object') {
    for (const [name, entry] of Object.entries(lock.dependencies)) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      requirements.push(
        lockedDependency(name, entry.version, sourceFile, `dependencies.${name}`, 'package-lock', entry.dev === true)
      );
    }
  } else {
    errors.push({
      sourceFile,
      error: 'package-lock.json has no recognizable packages or dependencies sections',
      code: 'PARSE_ERROR',
      severity: 'warning',
    });
  }

  return { requirements, errors };
}

function parseYarnLock(sourceFile: string, content: string): { requirements: ProjectRequirement[]; errors: RequirementParseError[] } {
  const requirements: ProjectRequirement[] = [];
  const errors: RequirementParseError[] = [];
  const lines = content.split('\n');
  let currentNames: Array<{ name: string; requested?: string }> = [];
  let currentVersion: string | undefined;

  const flush = (): void => {
    if (currentNames.length > 0 && currentVersion) {
      for (const { name, requested } of currentNames) {
        requirements.push({
          id: requirementId(name),
          ecosystem: 'node',
          type: 'package-dependency',
          name,
          versionConstraint: requested,
          rawConstraint: requested,
          resolvedVersion: currentVersion,
          origin: 'lockfile',
          lockfileSource: 'yarn-lock',
          sourceFile,
          sourceSection: 'yarn-lock',
          developmentOnly: false,
          metadata: { locked: true },
        });
      }
    }
    currentNames = [];
    currentVersion = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    if (!rawLine.startsWith(' ') && !rawLine.startsWith('\t') && line.endsWith(':')) {
      flush();
      const header = line.slice(0, -1);
      for (const part of header.split(',')) {
        const cleaned = part.trim().replace(/^"|"$/g, '');
        const atIndex = cleaned[0] === '@' ? cleaned.indexOf('@', 1) : cleaned.indexOf('@');
        const name = atIndex > 0 ? cleaned.slice(0, atIndex) : cleaned;
        const requested = atIndex > 0 ? cleaned.slice(atIndex + 1) : undefined;
        if (name) {
          currentNames.push({ name, requested });
        }
      }
      continue;
    }
    const versionMatch = line.match(/^version\s+"?([^"\s]+)"?/);
    if (versionMatch && versionMatch[1] && currentNames.length > 0 && !currentVersion) {
      currentVersion = versionMatch[1];
    }
  }
  flush();

  if (requirements.length === 0) {
    errors.push({
      sourceFile,
      error: 'yarn.lock has no recognizable version entries (only v1 format is supported)',
      code: 'PARSE_ERROR',
      severity: 'warning',
    });
  }

  return { requirements, errors };
}

function parsePnpmLock(sourceFile: string, content: string): { requirements: ProjectRequirement[]; errors: RequirementParseError[] } {
  const requirements: ProjectRequirement[] = [];
  const errors: RequirementParseError[] = [];
  const importerEntries: ProjectRequirement[] = [];
  const packageEntries: ProjectRequirement[] = [];
  const lines = content.split('\n');
  let section = '';
  let currentName: string | undefined;
  let currentSpecifier: string | undefined;

  const importerName = (line: string): string | undefined => {
    const match = line.match(/^\s{2}([^:\s][^:]*):\s*$/);
    return match && match[1] ? match[1].trim() : undefined;
  };

  for (const rawLine of lines) {
    if (/^[^\s]/.test(rawLine) && rawLine.trim().endsWith(':')) {
      section = rawLine.trim().slice(0, -1);
      currentName = undefined;
      currentSpecifier = undefined;
      continue;
    }
    if (section === 'dependencies' || section === 'devDependencies' || section === 'optionalDependencies') {
      const name = importerName(rawLine);
      if (name) {
        currentName = name;
        currentSpecifier = undefined;
        continue;
      }
      const specMatch = rawLine.match(/specifier:\s*(.+)/);
      if (specMatch && specMatch[1] && currentName) {
        currentSpecifier = specMatch[1].trim();
        continue;
      }
      const versionMatch = rawLine.match(/version:\s*(.+)/);
      if (versionMatch && versionMatch[1] && currentName) {
        const raw = versionMatch[1].trim();
        const paren = raw.indexOf('(');
        const version = (paren > 0 ? raw.slice(0, paren) : raw).trim();
        importerEntries.push({
          id: requirementId(currentName),
          ecosystem: 'node',
          type: 'package-dependency',
          name: currentName,
          versionConstraint: currentSpecifier,
          rawConstraint: currentSpecifier,
          resolvedVersion: version || undefined,
          origin: 'lockfile',
          lockfileSource: 'pnpm-lock',
          sourceFile,
          sourceSection: `${section}.${currentName}`,
          developmentOnly: section === 'devDependencies',
          metadata: { scope: section === 'devDependencies' ? 'development' : 'production', locked: true },
        });
        currentName = undefined;
        currentSpecifier = undefined;
      }
    } else if (section === 'packages' || section === 'snapshots') {
      const packageMatch = rawLine.match(/^\s{2}([^:\s][^:]*):\s*$/);
      if (packageMatch && packageMatch[1]) {
        const key = packageMatch[1].trim();
        const atIndex = key[0] === '@' ? key.indexOf('@', 1) : key.indexOf('@');
        if (atIndex > 0) {
          const name = key.slice(0, atIndex).replace(/^\//, '');
          const version = key.slice(atIndex + 1);
          if (name && version) {
            packageEntries.push(
              lockedDependency(name, version, sourceFile, `packages.${key}`, 'pnpm-lock', false)
            );
          }
        }
      }
    }
  }

  const importerNames = new Set(importerEntries.map((entry) => entry.name));
  requirements.push(...importerEntries);
  for (const entry of packageEntries) {
    if (!importerNames.has(entry.name)) {
      requirements.push(entry);
    }
  }

  if (requirements.length === 0) {
    errors.push({
      sourceFile,
      error: 'pnpm-lock.yaml has no recognizable entries',
      code: 'PARSE_ERROR',
      severity: 'warning',
    });
  }

  return { requirements, errors };
}

export class NodeLockfileParser implements RequirementParser {
  readonly ecosystem = 'node';
  readonly supportedFormats = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const fileName = sourceFile.split('/').pop()?.toLowerCase() || '';
    let result: { requirements: ProjectRequirement[]; errors: RequirementParseError[] } = {
      requirements: [],
      errors: [],
    };

    try {
      if (fileName === 'package-lock.json' || fileName === 'npm-shrinkwrap.json') {
        result = parsePackageLock(sourceFile, content);
      } else if (fileName === 'yarn.lock') {
        result = parseYarnLock(sourceFile, content);
      } else if (fileName === 'pnpm-lock.yaml') {
        result = parsePnpmLock(sourceFile, content);
      } else if (fileName === 'bun.lock') {
        try {
          const manifest = JSON.parse(content) as { packages?: Record<string, unknown> };
          if (!manifest || typeof manifest !== 'object' || !manifest.packages) {
            result.errors.push({
              sourceFile,
              error: 'bun.lock is not a recognized JSON lockfile; binary bun.lockb files are not supported',
              code: 'UNSUPPORTED_FORMAT',
              severity: 'warning',
            });
          } else {
            for (const [name, entry] of Object.entries(manifest.packages)) {
              const version =
                entry && typeof entry === 'object' && 'version' in entry
                  ? String((entry as { version: unknown }).version)
                  : undefined;
              result.requirements.push(lockedDependency(name, version, sourceFile, `packages.${name}`, 'bun-lock', false));
            }
          }
        } catch (err) {
          result.errors.push({
            sourceFile,
            error: `Failed to parse bun.lock: ${err instanceof Error ? err.message : String(err)}`,
            code: 'PARSE_ERROR',
            severity: 'warning',
          });
        }
      } else {
        result.errors.push({
          sourceFile,
          error: `Unsupported Node lockfile format: ${fileName}`,
          code: 'UNSUPPORTED_FORMAT',
          severity: 'warning',
        });
      }
    } catch (err) {
      result.errors.push({
        sourceFile,
        error: `Failed to parse lockfile: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PARSE_ERROR',
        severity: 'error',
      });
    }

    return { projectId: 'unknown', sourceFiles: [sourceFile], requirements: result.requirements, parseErrors: result.errors };
  }
}
