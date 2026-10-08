import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export type NpmInstallStatus = 'installed' | 'missing';

export interface NpmInstallState {
  readonly status: NpmInstallStatus;
  /** Installed version from the package's own manifest, when it could be read. */
  readonly installedVersion?: string;
  /** Workspace-relative path that was inspected (for deterministic evidence). */
  readonly checkedPath: string;
}

/**
 * Whether a dependency name is safe to join onto a project directory.
 *
 * Rejects anything that could escape the project tree (`..`, absolute paths,
 * separators outside the single optional scope slash) so the inspector can
 * never be steered at files outside the workspace. Unsafe names report
 * `missing` rather than throwing, keeping diagnostics total.
 */
function isSafePackageName(name: string): boolean {
  if (!name || name.length > 214) {
    return false;
  }
  if (name.includes('\0') || name.includes('..')) {
    return false;
  }
  if (name.startsWith('-') || name.startsWith('.')) {
    return false;
  }
  if (/[\s\\:{}[\]()$`'"!*?~#<>|&;]/.test(name)) {
    return false;
  }
  const segments = name.split('/');
  if (segments.some((segment) => segment === '')) {
    return false;
  }
  if (name.startsWith('@')) {
    return segments.length === 2;
  }
  return segments.length === 1;
}

/**
 * Establish the project-local installed state of an npm package from the
 * actual dependency tree: `<projectDir>/node_modules/<name>/package.json`.
 *
 * - Read-only: a single manifest read, no commands, no network.
 * - Project-local only: global npm packages are never consulted, so a
 *   globally installed package can never mark a project dependency satisfied.
 * - A lockfile alone proves nothing about the current tree and is ignored
 *   here; it remains supporting evidence elsewhere, never proof of install.
 */
export async function inspectNpmPackageInstallState(
  projectDir: string,
  packageName: string
): Promise<NpmInstallState> {
  const checkedPath = `node_modules/${packageName}/package.json`;
  const missing: NpmInstallState = { status: 'missing', checkedPath };
  if (!isSafePackageName(packageName)) {
    return missing;
  }
  let manifestPath: string;
  try {
    const root = resolve(projectDir);
    manifestPath = resolve(root, 'node_modules', ...packageName.split('/'), 'package.json');
    if (manifestPath !== root && !manifestPath.startsWith(root + sep)) {
      return missing;
    }
  } catch {
    return missing;
  }
  let content: string;
  try {
    content = await readFile(manifestPath, 'utf-8');
  } catch {
    return missing;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return missing;
  }
  const version =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { version?: unknown }).version
      : undefined;
  if (typeof version !== 'string' || version.trim() === '') {
    return missing;
  }
  return { status: 'installed', installedVersion: version.trim(), checkedPath };
}
