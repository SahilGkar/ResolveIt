import { spawn, type ChildProcess } from 'child_process';

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

      return new Promise((resolve) => {
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
          resolve({
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
          resolve({
            exitCode: code ?? -1,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            timedOut,
          });
        });

        childProcess.on('error', (err: Error) => {
          clearTimeout(timeoutId);
          resolve({
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

export function createMockCommandRunner(responses: Map<string, { exitCode: number; stdout: string; stderr: string; timedOut: boolean; error?: string }>): CommandRunner {
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