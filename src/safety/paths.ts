import { promises as fs } from 'fs';
import { resolve, isAbsolute, relative, parse, sep } from 'path';
import { SECURITY_LIMITS } from './limits.js';

export interface WorkspaceTarget {
  readonly ok: true;
  readonly resolvedPath: string;
}

export interface WorkspaceTargetError {
  readonly ok: false;
  readonly error: string;
}

export type WorkspaceTargetResult = WorkspaceTarget | WorkspaceTargetError;

function decodeTraversalAttempts(input: string): string {
  let current = input;
  for (let round = 0; round < 3; round += 1) {
    if (!current.includes('%')) {
      return current;
    }
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) {
        return current;
      }
      current = decoded;
    } catch {
      return current;
    }
  }
  return current;
}

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      return true;
    }
  }
  return false;
}

function isUncPath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  return normalized.startsWith('//') && normalized.length > 2;
}

function looksLikeWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}

function lexicalSegments(value: string): string[] {
  return value.replace(/\\/g, '/').split('/');
}

function rootsMatch(workspaceRoot: string, candidateRoot: string): boolean {
  if (process.platform === 'win32') {
    return workspaceRoot.toLowerCase() === candidateRoot.toLowerCase();
  }
  return workspaceRoot === candidateRoot;
}

function isContained(resolvedWorkspace: string, resolvedCandidate: string): boolean {
  const workspaceDrive = parse(resolvedWorkspace).root;
  const candidateDrive = parse(resolvedCandidate).root;
  if (!rootsMatch(workspaceDrive, candidateDrive)) {
    return false;
  }
  const rel = relative(resolvedWorkspace, resolvedCandidate);
  if (rel === '') {
    return true;
  }
  if (isAbsolute(rel)) {
    return false;
  }
  const segments = rel.split(sep);
  if (segments[0] === '..') {
    return false;
  }
  return true;
}

export interface ContainmentOptions {
  readonly rejectAbsolutePaths?: boolean;
}

export function checkWorkspaceContainment(
  workspaceRoot: string,
  filePath: string,
  options: ContainmentOptions = {}
): WorkspaceTargetResult {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
    return { ok: false, error: 'Missing workspace root for path validation' };
  }
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return { ok: false, error: 'Missing file path for path validation' };
  }
  if (filePath.length > SECURITY_LIMITS.maxPathLength) {
    return { ok: false, error: `File path exceeds maximum length (${SECURITY_LIMITS.maxPathLength})` };
  }
  if (filePath.includes('\0')) {
    return { ok: false, error: 'File path contains NUL byte' };
  }
  if (hasControlCharacters(filePath)) {
    return { ok: false, error: 'File path contains control characters' };
  }

  const decoded = decodeTraversalAttempts(filePath);
  const segments = lexicalSegments(decoded);
  if (segments.includes('..')) {
    return { ok: false, error: `File path contains directory traversal: ${filePath}` };
  }

  if (isUncPath(decoded) || isUncPath(filePath)) {
    return { ok: false, error: `UNC paths are not allowed: ${filePath}` };
  }

  if (options.rejectAbsolutePaths && (isAbsolute(decoded) || looksLikeWindowsDrivePath(decoded))) {
    return { ok: false, error: `Absolute paths are not allowed: ${filePath}` };
  }

  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedCandidate = isAbsolute(decoded) || looksLikeWindowsDrivePath(decoded)
    ? resolve(decoded)
    : resolve(resolvedWorkspace, decoded);

  if (!isContained(resolvedWorkspace, resolvedCandidate)) {
    return { ok: false, error: `File path ${filePath} is outside workspace` };
  }

  return { ok: true, resolvedPath: resolvedCandidate };
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  for (;;) {
    try {
      await fs.lstat(current);
      return current;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      const parent = resolve(current, '..');
      if (parent === current) {
        return current;
      }
      current = parent;
    }
  }
}

export async function verifyNoSymlinkEscape(
  workspaceRoot: string,
  resolvedCandidate: string
): Promise<WorkspaceTargetResult> {
  const resolvedWorkspace = resolve(workspaceRoot);
  let workspaceReal: string;
  try {
    workspaceReal = await fs.realpath(resolvedWorkspace);
  } catch {
    return { ok: false, error: 'Workspace root is not accessible; refusing to write' };
  }

  let anchor: string;
  try {
    anchor = await nearestExistingAncestor(resolvedCandidate);
  } catch {
    return { ok: false, error: 'Unable to inspect target path; refusing to write' };
  }

  let anchorReal: string;
  try {
    anchorReal = await fs.realpath(anchor);
  } catch {
    return { ok: false, error: 'Unable to resolve target path; refusing to write' };
  }

  if (!isContained(workspaceReal, anchorReal)) {
    return { ok: false, error: 'Target resolves outside the workspace via symlink; refusing to write' };
  }

  const remainder = relative(anchor, resolvedCandidate);
  if (remainder !== '' && !isContained(workspaceReal, resolve(anchorReal, remainder))) {
    return { ok: false, error: 'Target resolves outside the workspace via symlink; refusing to write' };
  }

  return { ok: true, resolvedPath: resolvedCandidate };
}

export async function verifyWorkspaceTarget(
  workspaceRoot: string,
  filePath: string,
  options: ContainmentOptions = {}
): Promise<WorkspaceTargetResult> {
  const lexical = checkWorkspaceContainment(workspaceRoot, filePath, options);
  if (!lexical.ok) {
    return lexical;
  }
  return verifyNoSymlinkEscape(workspaceRoot, lexical.resolvedPath);
}
