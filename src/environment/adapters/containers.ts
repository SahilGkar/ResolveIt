import type { ToolInstallation } from '../../core/models.js';
import type { CommandRunner } from '../command-runner.js';

export interface ContainerInfo {
  readonly docker: ToolInstallation;
  readonly dockerCompose: ToolInstallation;
  readonly dockerRunning: boolean;
  readonly dockerInfo?: Readonly<Record<string, unknown>>;
}

export async function detectContainers(runner: CommandRunner): Promise<ContainerInfo> {
  const docker = await detectDocker(runner);
  const dockerCompose = await detectDockerCompose(runner);
  const dockerRunning = docker.available && dockerCompose.available 
    ? await checkDockerRunning(runner)
    : false;
  const dockerInfo = docker.available ? await getDockerInfo(runner) : undefined;

  return {
    docker,
    dockerCompose,
    dockerRunning,
    dockerInfo,
  };
}

async function detectDocker(runner: CommandRunner): Promise<ToolInstallation> {
  const result = await runner.run('docker', ['--version']);
  if (result.exitCode === 0) {
    const version = extractVersion(result.stdout + result.stderr, /Docker version\s+(\d+\.\d+\.\d+)/);
    const path = await findCommandPath(runner, 'docker');
    return {
      name: 'Docker',
      command: 'docker',
      version,
      path,
      available: true,
      source: 'command',
      details: {},
    };
  }
  return createMissingTool('Docker', 'docker');
}

async function detectDockerCompose(runner: CommandRunner): Promise<ToolInstallation> {
  // Try docker compose (v2)
  let result = await runner.run('docker', ['compose', 'version']);
  if (result.exitCode === 0) {
    const version = extractVersion(result.stdout + result.stderr, /Docker Compose version\s+(\d+\.\d+\.\d+)/);
    return {
      name: 'Docker Compose',
      command: 'docker compose',
      version,
      path: undefined,
      available: true,
      source: 'command',
      details: { versionType: 'v2' },
    };
  }

  // Try legacy docker-compose
  result = await runner.run('docker-compose', ['--version']);
  if (result.exitCode === 0) {
    const version = extractVersion(result.stdout + result.stderr, /docker-compose version\s+(\d+\.\d+\.\d+)/);
    const path = await findCommandPath(runner, 'docker-compose');
    return {
      name: 'Docker Compose',
      command: 'docker-compose',
      version,
      path,
      available: true,
      source: 'command',
      details: { versionType: 'legacy' },
    };
  }

  return createMissingTool('Docker Compose', 'docker-compose');
}

async function checkDockerRunning(runner: CommandRunner): Promise<boolean> {
  const result = await runner.run('docker', ['info'], { timeout: 15000 });
  return result.exitCode === 0;
}

async function getDockerInfo(runner: CommandRunner): Promise<Record<string, unknown> | undefined> {
  const result = await runner.run('docker', ['info', '--format', '{{json .}}'], { timeout: 15000 });
  if (result.exitCode === 0 && result.stdout) {
    try {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      return parsed;
    } catch {
      // Ignore parse errors
    }
  }
  return undefined;
}

function extractVersion(output: string, regex?: RegExp): string | undefined {
  if (!output) return undefined;
  if (regex) {
    const match = output.match(regex);
    if (match && match[1]) {
      return match[1];
    }
  }
  const lines = output.trim().split('\n');
  for (const line of lines) {
    const versionMatch = line.match(/(\d+\.\d+\.\d+(?:[-\w.]+)?)/);
    if (versionMatch) {
      return versionMatch[1];
    }
  }
  return undefined;
}

async function findCommandPath(runner: CommandRunner, command: string): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      const result = await runner.run('where', [command]);
      if (result.exitCode === 0 && result.stdout) {
        const parts = result.stdout.split('\n');
        if (parts.length > 0) {
          const first = parts[0];
          if (first) {
            return first.trim();
          }
        }
      }
    } else {
      const result = await runner.run('which', [command]);
      if (result.exitCode === 0 && result.stdout) {
        return result.stdout.trim();
      }
    }
  } catch {
    // Ignore
  }
  return undefined;
}

function createMissingTool(name: string, command: string): ToolInstallation {
  return {
    name,
    command,
    version: undefined,
    path: undefined,
    available: false,
    source: 'command',
    details: { reason: 'not found in PATH' },
  };
}