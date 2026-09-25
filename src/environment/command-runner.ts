import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { checkWorkspaceContainment } from '../safety/paths.js';
import { SECURITY_LIMITS } from '../safety/limits.js';
import { redactSecrets } from '../safety/secrets.js';

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly error?: string;
}

export interface CommandRunnerOptions {
  readonly timeout?: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CommandRunner {
  run(command: string, args: ReadonlyArray<string>, options?: CommandRunnerOptions): Promise<CommandResult>;
}

const DEFAULT_TIMEOUT = 10000;

export function createCommandRunner(): CommandRunner {
  return {
    run(command: string, args: ReadonlyArray<string>, options: CommandRunnerOptions = {}): Promise<CommandResult> {
      const timeout = options.timeout ?? DEFAULT_TIMEOUT;
      const cwd = options.cwd;
      const env = options.env ?? process.env;

      return new Promise((resolvePromise) => {
        let timedOut = false;
        let stdout = '';
        let stderr = '';

        let childProcess: ChildProcess;

        try {
          childProcess = spawn(command, args, {
            cwd,
            env,
            windowsHide: true,
            shell: process.platform === 'win32',
          });
        } catch (err) {
          resolvePromise({
            exitCode: -1,
            stdout: '',
            stderr: '',
            timedOut: false,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }

        const timeoutId = setTimeout(() => {
          timedOut = true;
          try {
            childProcess.kill('SIGTERM');
          } catch {
            // Ignore kill errors
          }
        }, timeout);

        childProcess.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        childProcess.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        childProcess.on('close', (code) => {
          clearTimeout(timeoutId);
          resolvePromise({
            exitCode: code ?? -1,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            timedOut,
          });
        });

        childProcess.on('error', (err: Error) => {
          clearTimeout(timeoutId);
          resolvePromise({
            exitCode: -1,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            timedOut: false,
            error: err.message,
          });
        });
      });
    },
  };
}

export function createMockCommandRunner(responses: Map<string, CommandResult>): CommandRunner {
  return {
    run(command: string, args: ReadonlyArray<string>): Promise<CommandResult> {
      const key = `${command} ${args.join(' ')}`;
      return Promise.resolve(responses.get(key) ?? {
        exitCode: -1,
        stdout: '',
        stderr: 'command not mocked',
        timedOut: false,
        error: 'command not mocked',
      });
    },
  };
}

export const REPAIR_EXECUTABLE_ALLOWLIST: ReadonlyArray<string> = [
  'npm',
  'pip',
  'pip3',
  'cargo',
  'go',
  'composer',
  'bundle',
  'python',
  'python3',
  'py',
];

const SAFE_ENV_KEYS = new Set(
  [
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'HOME',
    'USER',
    'LANG',
    'LC_ALL',
    'LC_LANG',
    'PYTHONUTF8',
    'PYTHONIOENCODING',
    'VIRTUAL_ENV',
  ].map((key) => key.toUpperCase()),
);

const UNSAFE_ARG_PATTERN = /[\0;&|$`'"\n\r()<>!^%]/;

export interface SafeCommandRunnerConfig {
  readonly allowedExecutables: ReadonlyArray<string>;
  readonly allowedRoot?: string;
  readonly defaultTimeoutMs?: number;
  readonly extraEnv?: Readonly<Record<string, string>>;
}

function buildSafeEnv(extraEnv?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && SAFE_ENV_KEYS.has(key.toUpperCase())) {
      env[key] = value;
    }
  }
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      env[key] = value;
    }
  }
  return env;
}

function validateSafeInvocation(
  config: SafeCommandRunnerConfig,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string | undefined
): string | undefined {
  if (typeof command !== 'string' || command.trim() === '') {
    return 'Missing executable';
  }
  const normalized = command.toLowerCase();
  if (command.includes('/') || command.includes('\\') || command.includes(':')) {
    return `Executable must be a bare allowlisted name, not a path: ${command}`;
  }
  if (!config.allowedExecutables.map((entry) => entry.toLowerCase()).includes(normalized)) {
    return `Executable is not allowlisted: ${command}`;
  }
  for (const arg of args) {
    if (typeof arg !== 'string') {
      return 'Command arguments must be strings';
    }
    if (arg.length === 0 || arg.length > 1024) {
      return `Invalid command argument length: ${arg.slice(0, 64)}`;
    }
    if (UNSAFE_ARG_PATTERN.test(arg)) {
      return `Command argument contains shell metacharacters and is rejected: ${arg.slice(0, 64)}`;
    }
  }
  if (cwd !== undefined) {
    if (config.allowedRoot) {
      const containment = checkWorkspaceContainment(config.allowedRoot, resolve(cwd));
      if (!containment.ok) {
        return `Working directory is outside the allowed root: ${containment.error}`;
      }
    }
  }
  return undefined;
}

function appendCapped(current: string, chunk: string): { text: string; truncated: boolean } {
  const max = SECURITY_LIMITS.maxCommandOutputBytes;
  if (current.length >= max) {
    return { text: current, truncated: true };
  }
  const combined = current + chunk;
  if (combined.length > max) {
    return { text: `${combined.slice(0, max)}\n[output truncated at ${max} bytes]`, truncated: true };
  }
  return { text: combined, truncated: false };
}

export function createSafeCommandRunner(config: SafeCommandRunnerConfig): CommandRunner {
  const allowed = config.allowedExecutables.map((entry) => entry.toLowerCase());
  const defaultTimeout = Math.min(
    config.defaultTimeoutMs ?? SECURITY_LIMITS.defaultCommandTimeoutMs,
    SECURITY_LIMITS.maxCommandTimeoutMs
  );

  return {
    run(command: string, args: ReadonlyArray<string>, options: CommandRunnerOptions = {}): Promise<CommandResult> {
      const cwd = options.cwd;
      const rejection = validateSafeInvocation({ ...config, allowedExecutables: allowed }, command, args, cwd);
      if (rejection) {
        return Promise.resolve({
          exitCode: -1,
          stdout: '',
          stderr: '',
          timedOut: false,
          error: rejection,
        });
      }

      const timeout = Math.min(options.timeout ?? defaultTimeout, SECURITY_LIMITS.maxCommandTimeoutMs);
      const env = buildSafeEnv(config.extraEnv);

      return new Promise((resolvePromise) => {
        let timedOut = false;
        let stdout = '';
        let stderr = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;

        let childProcess: ChildProcess;
        try {
          childProcess = spawn(command, [...args], {
            cwd,
            env,
            windowsHide: true,
            shell: process.platform === 'win32',
          });
        } catch (err) {
          resolvePromise({
            exitCode: -1,
            stdout: '',
            stderr: '',
            timedOut: false,
            error: redactSecrets(err instanceof Error ? err.message : String(err)),
          });
          return;
        }

        const timeoutId = setTimeout(() => {
          timedOut = true;
          try {
            childProcess.kill('SIGTERM');
          } catch {
            // Ignore kill errors
          }
        }, timeout);

        childProcess.stdout?.on('data', (data: Buffer) => {
          if (!stdoutTruncated) {
            const next = appendCapped(stdout, data.toString());
            stdout = next.text;
            stdoutTruncated = next.truncated;
          }
        });

        childProcess.stderr?.on('data', (data: Buffer) => {
          if (!stderrTruncated) {
            const next = appendCapped(stderr, data.toString());
            stderr = next.text;
            stderrTruncated = next.truncated;
          }
        });

        childProcess.on('close', (code) => {
          clearTimeout(timeoutId);
          resolvePromise({
            exitCode: code ?? -1,
            stdout: redactSecrets(stdout.trim()),
            stderr: redactSecrets(stderr.trim()),
            timedOut,
          });
        });

        childProcess.on('error', (err: Error) => {
          clearTimeout(timeoutId);
          resolvePromise({
            exitCode: -1,
            stdout: redactSecrets(stdout.trim()),
            stderr: redactSecrets(stderr.trim()),
            timedOut: false,
            error: redactSecrets(err.message),
          });
        });
      });
    },
  };
}
