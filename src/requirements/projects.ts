export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/');
}

export function dirnameOf(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const index = normalized.lastIndexOf('/');
  if (index <= 0) {
    return '.';
  }
  return normalized.slice(0, index);
}

export function stableProjectId(projectRoot: string): string {
  if (projectRoot === '.' || projectRoot === '') {
    return 'root';
  }
  return normalizeRelativePath(projectRoot).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'root';
}

export function matchesManifestPattern(fileName: string, pattern: string): boolean {
  const name = fileName.toLowerCase();
  const rule = pattern.toLowerCase();

  if (!rule.includes('*')) {
    return name === rule;
  }

  const regex = `^${rule.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`;
  return new RegExp(regex).test(name);
}

export function isManifestFile(fileName: string, patterns: ReadonlyArray<string>): boolean {
  return patterns.some((pattern) => matchesManifestPattern(fileName, pattern));
}

export function formatMatchesAny(formats: ReadonlyArray<string>, fileName: string): boolean {
  const normalized = fileName.toLowerCase();
  return formats.some((format) => {
    const lower = format.toLowerCase();
    if (!lower.includes('*')) {
      return normalized === lower;
    }
    return matchesManifestPattern(normalized, lower);
  });
}

export function assignProject(
  relativeFilePath: string,
  markerRelativeDirs: ReadonlyArray<string>
): { projectId: string; projectRoot: string } {
  const fileDir = dirnameOf(relativeFilePath);
  let best: string | undefined;

  for (const rawDir of markerRelativeDirs) {
    const dir = normalizeRelativePath(rawDir);
    const candidate = dir === '' ? '.' : dir;
    const isAncestor =
      candidate === '.' || fileDir === candidate || fileDir.startsWith(`${candidate}/`);
    if (isAncestor && (best === undefined || candidate.length > best.length)) {
      best = candidate;
    }
  }

  const projectRoot = best ?? '.';
  return { projectId: stableProjectId(projectRoot), projectRoot };
}

export function requirementIdentity(requirement: {
  readonly ecosystem: string;
  readonly type: string;
  readonly name: string;
  readonly versionConstraint?: string;
  readonly sourceFile: string;
  readonly sourceSection?: string;
}): string {
  return [
    requirement.ecosystem,
    requirement.type,
    requirement.name,
    requirement.versionConstraint ?? '',
    requirement.sourceFile,
    requirement.sourceSection ?? '',
  ].join('|');
}
