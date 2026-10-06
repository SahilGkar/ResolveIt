import { promises as fs, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { createConnection, type Socket } from 'net';
import { join, resolve } from 'path';
import {
  createSafeCommandRunner,
  spawnMonitoredCommand,
  type CancellationSignal,
  type CommandResult,
} from '../environment/command-runner.js';
import { SECURITY_LIMITS } from '../safety/limits.js';

/**
 * Terminating project test discovery and execution, kept strictly separate
 * from launching the application (see the smoke test below).
 *
 * A "test" here is a command that finishes on its own and whose exit code
 * means pass/fail. This module never invents a command: it matches the
 * project's own files against a fixed table, then executes through the
 * existing safe command runner (executable allowlist, workspace containment,
 * argument metacharacter rejection, output capping, secret redaction).
 */

export type ProjectTestRunner = 'npm' | 'pytest' | 'cargo' | 'go' | 'dotnet' | 'mvn' | 'gradle';

export interface ProjectTestCommand {
  readonly runner: ProjectTestRunner;
  /** Arguments passed to the runner, e.g. `['test', './...']`. */
  readonly args: ReadonlyArray<string>;
  /** Human readable label, e.g. `npm test`. */
  readonly label: string;
  /** Where the command was detected from, e.g. `package.json#scripts.test`. */
  readonly source: string;
}

const MANIFEST_MAX_BYTES = 1024 * 1024;

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    const stats = await fs.stat(path);
    if (stats.size > MANIFEST_MAX_BYTES) {
      return undefined;
    }
    raw = await fs.readFile(path, 'utf-8');
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function fileContains(path: string, needle: string): Promise<boolean> {
  try {
    const stats = await fs.stat(path);
    if (stats.size > MANIFEST_MAX_BYTES) {
      return false;
    }
    const content = await fs.readFile(path, 'utf-8');
    return content.includes(needle);
  } catch {
    return false;
  }
}

function hasUsableScript(manifest: Record<string, unknown> | undefined, name: string): boolean {  if (!manifest) {
    return false;
  }
  const scripts = manifest['scripts'];
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) {
    return false;
  }
  const value = (scripts as Record<string, unknown>)[name];
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Detect a terminating test command from project files only.
 * Returns `undefined` when nothing safe can be determined. Development servers
 * (`dev`, `start`, `serve`) are deliberately NOT test commands; see
 * `detectProjectSmokeCommand`.
 */
export async function detectProjectTestCommand(
  projectRoot: string
): Promise<ProjectTestCommand | undefined> {
  const root = resolve(projectRoot);

  const manifest = await readJsonFile(join(root, 'package.json'));
  if (manifest && hasUsableScript(manifest, 'test')) {
    return { runner: 'npm', args: ['test'], label: 'npm test', source: 'package.json#scripts.test' };
  }

  if (
    (await fileExists(join(root, 'pytest.ini'))) ||
    (await fileExists(join(root, 'tox.ini'))) ||
    (await fileContains(join(root, 'pyproject.toml'), '[tool.pytest')) ||
    (await fileContains(join(root, 'setup.cfg'), '[tool:pytest'))
  ) {
    return { runner: 'pytest', args: ['-q'], label: 'pytest -q', source: 'pytest configuration' };
  }

  if (await fileExists(join(root, 'Cargo.toml'))) {
    return { runner: 'cargo', args: ['test', '--quiet'], label: 'cargo test', source: 'Cargo.toml' };
  }

  if (await fileExists(join(root, 'go.mod'))) {
    return { runner: 'go', args: ['test', './...'], label: 'go test ./...', source: 'go.mod' };
  }

  const dotnetFiles = await fs.readdir(root).catch(() => [] as string[]);
  if (dotnetFiles.some((entry) => entry.endsWith('.sln') || entry.endsWith('.csproj'))) {
    return { runner: 'dotnet', args: ['test', '--nologo'], label: 'dotnet test', source: '.NET project file' };
  }

  if (await fileExists(join(root, 'pom.xml'))) {
    return { runner: 'mvn', args: ['-q', '-B', 'test'], label: 'mvn test', source: 'pom.xml' };
  }

  if (await fileExists(join(root, 'build.gradle')) || (await fileExists(join(root, 'build.gradle.kts')))) {
    return { runner: 'gradle', args: ['test', '--quiet'], label: 'gradle test', source: 'Gradle build file' };
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
  readonly cancelled?: boolean;
  readonly error?: string;
  readonly message: string;
}

export const NO_PROJECT_TEST_COMMAND_MESSAGE =
  'No safe project test command was detected.';

function summarizeTest(result: CommandResult, cancelled: boolean): string {
  if (cancelled) {
    return 'Project test was cancelled before it finished.';
  }
  if (result.timedOut) {
    return `Project test timed out after ${SECURITY_LIMITS.maxCommandTimeoutMs}ms.`;
  }
  if (result.error) {
    return `Project test could not be executed: ${result.error}`;
  }
  if (result.exitCode === 0) {
    return 'Project test passed.';
  }
  return `Project test failed with exit code ${result.exitCode}.`;
}

/**
 * Boolean coercion for an optional cancellation signal. Written as a helper
 * (rather than `signal?.aborted === true`) to keep the checks greppable.
 */
function isAborted(signal: CancellationSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * Run the project's own terminating test command.
 *
 * Nothing is executed when no safe test command exists; the result then reports
 * `attempted: false` so the UI can say so plainly instead of implying a test ran.
 * A cancelled run reports `cancelled: true` and `success: false`: cancellation
 * is never reported as a pass.
 */
export async function runProjectTest(
  projectRoot: string,
  timeoutMs?: number,
  signal?: CancellationSignal
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

  if (isAborted(signal)) {
    return {
      attempted: true,
      command,
      success: false,
      exitCode: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      cancelled: true,
      error: 'operation cancelled',
      message: 'Project test was cancelled before it finished.',
    };
  }

  const runner = createSafeCommandRunner({
    allowedExecutables: [command.runner],
    allowedRoot: root,
    defaultTimeoutMs: timeoutMs ?? SECURITY_LIMITS.maxCommandTimeoutMs,
  });

  const result = await runner.run(command.runner, [...command.args], {
    cwd: root,
    ...(signal === undefined ? {} : { signal }),
  });
  const cancelled = isAborted(signal) || result.error === 'operation cancelled';

  return {
    attempted: true,
    command,
    success: !cancelled && !result.timedOut && !result.error && result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    ...(cancelled ? { cancelled: true as const } : {}),
    ...(result.error === undefined ? {} : { error: result.error }),
    message: summarizeTest(result, cancelled),
  };
}

/**
 * Application smoke (run) detection and execution. This is NOT a test: it
 * launches the project's own development/start command, waits for bounded
 * readiness on localhost, performs an HTTP readiness check where possible,
 * and then always terminates the whole process tree.
 *
 * A server that stays alive is the SUCCESS case here, never a timeout failure:
 * only the readiness wait is bounded.
 */

export interface ProjectSmokeCommand {
  readonly runner: 'npm';
  readonly args: ReadonlyArray<string>;
  readonly label: string;
  readonly source: string;
}

/**
 * Detect the project's normal development/start command. `dev` is preferred
 * because `start` commonly requires a prior production build; both are
 * explicitly development servers, never test commands.
 */
export async function detectProjectSmokeCommand(
  projectRoot: string
): Promise<ProjectSmokeCommand | undefined> {
  const root = resolve(projectRoot);
  const manifest = await readJsonFile(join(root, 'package.json'));
  if (!manifest) {
    return undefined;
  }
  if (hasUsableScript(manifest, 'dev')) {
    return { runner: 'npm', args: ['run', 'dev'], label: 'npm run dev', source: 'package.json#scripts.dev' };
  }
  if (hasUsableScript(manifest, 'start')) {
    return {
      runner: 'npm',
      args: ['run', 'start'],
      label: 'npm run start',
      source: 'package.json#scripts.start',
    };
  }
  return undefined;
}

export interface ProjectSmokeResult {
  /** Whether a smokeable start command could be determined at all. */
  readonly attempted: boolean;
  readonly command?: ProjectSmokeCommand;
  /** The process launched and stayed alive long enough to observe. */
  readonly started: boolean;
  /** A localhost port accepted a TCP connection. */
  readonly listening: boolean;
  /** An HTTP readiness check received a response (any status). */
  readonly responded: boolean;
  /** Overall: started, listening, and responded. */
  readonly success: boolean;
  readonly port?: number;
  readonly url?: string;
  readonly timedOut: boolean;
  readonly cancelled?: boolean;
  readonly output: string;
  readonly error?: string;
  readonly message: string;
}

export const NO_PROJECT_SMOKE_COMMAND_MESSAGE =
  'No safe run command was detected (looked for npm "dev" or "start" scripts).';

/** Ports probed when the start script does not declare one explicitly. */
const DEFAULT_SMOKE_PORTS: ReadonlyArray<number> = [3000, 5173, 8000, 8080, 5000, 4200, 8888];

export const SMOKE_READINESS_TIMEOUT_MS = 60000;

/**
 * Best-effort snapshot of currently listening TCP ports. Used to notice ports
 * a freshly launched dev server binds, whatever framework-specific port it
 * chose. Never throws: failure yields an empty set and the caller falls back
 * to declared/default ports.
 */
function listListeningPorts(): Set<number> {
  const ports = new Set<number>();
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('netstat', ['-ano', '-p', 'TCP'], {
        windowsHide: true,
        timeout: 10000,
        encoding: 'utf-8',
      });
      const output = typeof result.stdout === 'string' ? result.stdout : '';
      for (const line of output.split('\n')) {
        const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING/i.exec(line);
        if (match?.[1]) {
          const port = Number.parseInt(match[1], 10);
          if (port >= 1 && port <= 65535) {
            ports.add(port);
          }
        }
      }
      return ports;
    }
    const ss = spawnSync('ss', ['-tln'], { timeout: 10000, encoding: 'utf-8' });
    const ssOut = typeof ss.stdout === 'string' ? ss.stdout : '';
    if (ssOut.trim() !== '') {
      for (const line of ssOut.split('\n')) {
        const match = /:(\d+)\s/.exec(line);
        if (match?.[1]) {
          const port = Number.parseInt(match[1], 10);
          if (port >= 1 && port <= 65535) {
            ports.add(port);
          }
        }
      }
      return ports;
    }
  } catch {
    // Fall through to /proc parsing, then to empty.
  }
  try {
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
      const content = readFileSync(file, 'utf-8');
      for (const line of content.split('\n').slice(1)) {
        const parts = line.trim().split(/\s+/);
        const local = parts[1];
        const state = parts[3];
        if (state === '0A' && local && local.includes(':')) {
          const port = Number.parseInt((local.split(':')[1] ?? ''), 16);
          if (port >= 1 && port <= 65535) {
            ports.add(port);
          }
        }
      }
    }
  } catch {
    // No observable ports on this platform; caller uses static candidates.
  }
  return ports;
}

function extractDeclaredPort(scriptBody: string): number | undefined {
  const patterns = [/--port[= ](\d{2,5})/, /-p[= ](\d{2,5})/, /\bPORT=(\d{2,5})/];
  for (const pattern of patterns) {
    const match = pattern.exec(scriptBody);
    if (match?.[1]) {
      const port = Number.parseInt(match[1], 10);
      if (port >= 1 && port <= 65535) {
        return port;
      }
    }
  }
  return undefined;
}

function tryTcpConnect(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (value: boolean): void => {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    };
    const timer = setTimeout(() => {
      socket.destroy();
      done(false);
    }, timeoutMs);
    const socket: Socket = createConnection({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.end();
      done(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

async function httpGetResponds(url: string, timeoutMs: number): Promise<boolean> {
  const protocol = url.startsWith('https:') ? await import('https') : await import('http');
  return new Promise((resolvePromise) => {
    const request = protocol.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolvePromise(true);
    });
    request.on('timeout', () => {
      request.destroy();
      resolvePromise(false);
    });
    request.on('error', () => {
      resolvePromise(false);
    });
  });
}

export interface RunProjectSmokeOptions {
  readonly readinessTimeoutMs?: number;
  readonly signal?: CancellationSignal;
}

function smokeOutputOf(parts: { stdout: string; stderr: string }): string {
  return [parts.stdout, parts.stderr].filter((part) => part.length > 0).join('\n').slice(0, 4000);
}

/**
 * Launch the app, wait for bounded localhost readiness, then always terminate
 * the whole process tree. The readiness wait — not the server lifetime — is
 * what the timeout bounds, so a healthy long-running server reports success
 * instead of a timeout failure.
 */
export async function runProjectSmoke(
  projectRoot: string,
  options: RunProjectSmokeOptions = {}
): Promise<ProjectSmokeResult> {
  const root = resolve(projectRoot);
  const command = await detectProjectSmokeCommand(root);
  if (!command) {
    return {
      attempted: false,
      started: false,
      listening: false,
      responded: false,
      success: false,
      timedOut: false,
      output: '',
      message: NO_PROJECT_SMOKE_COMMAND_MESSAGE,
    };
  }

  if (isAborted(options.signal)) {
    return {
      attempted: true,
      command,
      started: false,
      listening: false,
      responded: false,
      success: false,
      timedOut: false,
      cancelled: true,
      output: '',
      error: 'operation cancelled',
      message: 'Smoke test was cancelled before it finished.',
    };
  }

  const readinessTimeout = Math.min(
    Math.max(options.readinessTimeoutMs ?? SMOKE_READINESS_TIMEOUT_MS, 1000),
    SECURITY_LIMITS.maxCommandTimeoutMs
  );

  const portsBeforeLaunch = listListeningPorts();
  const launched = spawnMonitoredCommand(
    { allowedExecutables: [command.runner], allowedRoot: root },
    command.runner,
    [...command.args],
    { cwd: root, timeoutMs: SECURITY_LIMITS.maxCommandTimeoutMs }
  );
  if ('error' in launched) {
    return {
      attempted: true,
      command,
      started: false,
      listening: false,
      responded: false,
      success: false,
      timedOut: false,
      output: '',
      error: launched.error,
      message: `Smoke test could not launch ${command.label}: ${launched.error}`,
    };
  }

  // Give the process a moment to fail fast (missing script, bad config) before
  // spending the readiness budget polling ports.
  const earlyExit = await Promise.race([
    launched.completion.then((result) => ({ exited: true as const, result })),
    new Promise<{ exited: false }>((resolvePromise) => setTimeout(() => resolvePromise({ exited: false }), 3000)),
  ]);
  if (earlyExit.exited && !isAborted(options.signal)) {
    const result = earlyExit.result;
    return {
      attempted: true,
      command,
      started: false,
      listening: false,
      responded: false,
      success: false,
      timedOut: false,
      output: smokeOutputOf(result),
      ...(result.error === undefined ? {} : { error: result.error }),
      message:
        result.error ?? result.timedOut
          ? `Smoke test could not launch ${command.label}: ${result.error ?? 'the process exited during startup'}.`
          : `Application exited immediately (exit code ${result.exitCode}) instead of staying up; not a running server.`,
    };
  }

  const manifest = await readJsonFile(join(root, 'package.json'));
  const scripts = manifest?.['scripts'];
  const scriptName = command.args[command.args.length - 1] ?? '';
  const scriptBody =
    scripts !== null && typeof scripts === 'object' && !Array.isArray(scripts)
      ? String((scripts as Record<string, unknown>)[scriptName] ?? '')
      : '';
  const declared = extractDeclaredPort(scriptBody);
  const staticPorts =
    declared === undefined ? DEFAULT_SMOKE_PORTS : [declared, ...DEFAULT_SMOKE_PORTS.filter((p) => p !== declared)];
  const deadline = Date.now() + readinessTimeout;
  let listeningPort: number | undefined;
  let aborted = false;
  // Ports are re-snapshotted every round: a framework-default port the server
  // binds after startup is discovered dynamically instead of being missed.
  const seenNewPorts: number[] = [];
  while (Date.now() < deadline && listeningPort === undefined && !aborted) {
    if (isAborted(options.signal)) {
      aborted = true;
      break;
    }
    for (const port of listListeningPorts()) {
      if (!portsBeforeLaunch.has(port) && !staticPorts.includes(port) && !seenNewPorts.includes(port)) {
        seenNewPorts.push(port);
      }
    }
    const candidates = [...staticPorts, ...seenNewPorts];
    for (const port of candidates) {
      // eslint-disable-next-line no-await-in-loop
      if (await tryTcpConnect(port, 1000)) {
        listeningPort = port;
        break;
      }
      if (isAborted(options.signal)) {
        aborted = true;
        break;
      }
    }
    if (listeningPort === undefined && !aborted && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    }
  }

  let responded = false;
  let url: string | undefined;
  if (listeningPort !== undefined && !aborted) {
    url = `http://localhost:${listeningPort}/`;
    responded = await httpGetResponds(url, 5000);
  }

  // The server's job is done either way: always terminate the whole tree,
  // including grandchildren the shell may have spawned.
  launched.killTree();
  // Do not wait indefinitely for a stubborn process: the verdict is already
  // determined by the readiness probes above.
  const completed = await Promise.race([
    launched.completion.then((result) => ({ done: true as const, result })),
    new Promise<{ done: false }>((resolvePromise) => setTimeout(() => resolvePromise({ done: false }), 10000)),
  ]);
  const output = completed.done ? smokeOutputOf(completed.result) : '(server output unavailable: process did not exit promptly)';

  if (aborted || isAborted(options.signal)) {
    return {
      attempted: true,
      command,
      started: listeningPort !== undefined,
      listening: listeningPort !== undefined,
      responded: false,
      success: false,
      ...(listeningPort === undefined ? {} : { port: listeningPort }),
      timedOut: false,
      cancelled: true,
      output,
      error: 'operation cancelled',
      message: 'Smoke test was cancelled before it finished.',
    };
  }

  if (listeningPort === undefined) {
    return {
      attempted: true,
      command,
      started: true,
      listening: false,
      responded: false,
      success: false,
      timedOut: true,
      output,
      message: `Application did not become reachable on localhost within ${Math.round(readinessTimeout / 1000)}s.`,
    };
  }

  if (!responded) {
    return {
      attempted: true,
      command,
      started: true,
      listening: true,
      responded: false,
      success: false,
      port: listeningPort,
      url,
      timedOut: false,
      output,
      message: `Application is listening on port ${listeningPort} but did not respond to the HTTP readiness check.`,
    };
  }

  return {
    attempted: true,
    command,
    started: true,
    listening: true,
    responded: true,
    success: true,
    port: listeningPort,
    url,
    timedOut: false,
    output,
    message: `Application started and responded successfully (${url}).`,
  };
}
