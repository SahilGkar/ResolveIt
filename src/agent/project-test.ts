import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { createSafeCommandRunner, type CommandResult } from '../environment/command-runner.js';
import { SECURITY_LIMITS } from '../safety/limits.js';

/**
 * Deterministic project test discovery and execution.
 *
 * This module never invents a command. It reads the project's own manifest and
 * selects from a fixed allowlist of script names, then executes through the
 * existing safe command runner (executable allowlist, workspace containment,
 * argument metacharacter rejection, output capping, secret redaction).
 */

export type ProjectTestRunner = 'npm';

export interface ProjectTestCommand {
  readonly runner: ProjectTestRunner;
  /** Arguments passed to the runner, e.g. `['run', 'test']`. */
  readonly args: ReadonlyArray<string>;
  /** Human readable label, e.g. `npm test`. */
  readonly label: string;
  /** Script name found in the manifest. */
  readonly script: string;
  readonly sourceFile: string;
}

/**
 * Script names we are willing to run, in priority order. Restricting to a fixed
 * list means an arbitrary `package.json` script name can never be executed.
 */
const ALLOWED_NPM_SCRIPTS: ReadonlyArray<string> = ['test', 'start', 'build'];

const MANIFEST_MAX_BYTES = 1024 * 1024;

async function readManifest(manifestPath: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    const stats = await fs.stat(manifestPath);
    if (stats.size > MANIFEST_MAX_BYTES) {
      return undefined;
    }
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function hasUsableScript(scripts: unknown, name: string): boolean {
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) {
    return false;
  }
  const value = (scripts as Record<string, unknown>)[name];
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Detect a safe project test command from manifest information only.
 * Returns `undefined` when nothing safe can be determined.
 */
export async function detectProjectTestCommand(
  projectRoot: string
): Promise<ProjectTestCommand | undefined> {
  const root = resolve(projectRoot);
  const manifest = await readManifest(join(root, 'package.json'));
  if (!manifest) {
    return undefined;
  }
  const scripts = manifest['scripts'];
  for (const script of ALLOWED_NPM_SCRIPTS) {
    if (hasUsableScript(scripts, script)) {
      return {
        runner: 'npm',
        // `npm test` is npm's own built-in; the others go through `npm run`.
        args: script === 'test' ? ['test'] : ['run', script],
        label: script === 'test' ? 'npm test' : `npm run ${script}`,
        script,
        sourceFile: 'package.json',
      };
    }
  }
  return undefined;
}

export interface ProjectTestResult {
  /** Whether a safe command could be determined at all. */
  readonly attempted: boolean;
  readonly command?: ProjectTestCommand;
  readonly success: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly error?: string;
  readonly message: string;
}

export const NO_PROJECT_TEST_COMMAND_MESSAGE =
  'No safe project test command was detected.';

function summarize(result: CommandResult): string {
  if (result.timedOut) {
    return `Command timed out after ${SECURITY_LIMITS.maxCommandTimeoutMs}ms.`;
  }
  if (result.error) {
    return `Command could not be executed: ${result.error}`;
  }
  if (result.exitCode === 0) {
    return 'Project test succeeded.';
  }
  return `Project test failed with exit code ${result.exitCode}.`;
}

/**
 * Detect and run the project's own test/start command.
 *
 * Nothing is executed when no allowlisted script exists; the result then reports
 * `attempted: false` so the UI can say so plainly instead of implying a test ran.
 */
export async function runProjectTest(
  projectRoot: string,
  timeoutMs?: number
): Promise<ProjectTestResult> {
  const root = resolve(projectRoot);
  const command = await detectProjectTestCommand(root);

  if (!command) {
    return {
      attempted: false,
      success: false,
      exitCode: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      message: NO_PROJECT_TEST_COMMAND_MESSAGE,
    };
  }

  const runner = createSafeCommandRunner({
    allowedExecutables: [command.runner],
    allowedRoot: root,
    defaultTimeoutMs: timeoutMs ?? SECURITY_LIMITS.maxCommandTimeoutMs,
  });

  const result = await runner.run(command.runner, [...command.args], { cwd: root });

  return {
    attempted: true,
    command,
    success: !result.timedOut && !result.error && result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    ...(result.error === undefined ? {} : { error: result.error }),
    message: summarize(result),
  };
}
