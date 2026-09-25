import type { CommandRunner } from './command-runner.js';
import { createCommandRunner, createMockCommandRunner, type CommandResult } from './command-runner.js';
import { detectOS } from './adapters/os.js';
import { detectAllRuntimes } from './adapters/runtime.js';
import { detectAllDevTools } from './adapters/tools.js';
import { detectAllPackageManagers } from './adapters/package-managers.js';
import { detectContainers } from './adapters/containers.js';
import type { EnvironmentInfo, OSInfo } from '../core/models.js';

export interface EnvironmentScannerOptions {
  readonly runner?: CommandRunner;
  readonly timeout?: number;
}

export async function scanEnvironment(options: EnvironmentScannerOptions = {}): Promise<EnvironmentInfo> {
  const runner = options.runner ?? createCommandRunner();
  
  const os = await detectOS(runner);
  const runtimes = await detectAllRuntimes(runner);
  const devTools = await detectAllDevTools(runner);
  const packageManagers = await detectAllPackageManagers(runner);
  const containers = await detectContainers(runner);
  const environmentVariables = getSafeEnvironmentVariables();

  return {
    os,
    runtimes,
    devTools,
    packageManagers,
    containers,
    environmentVariables,
    scannedAt: new Date(),
  };
}

function getSafeEnvironmentVariables(): Record<string, string> {
  const safeKeys = [
    'PATH',
    'HOME',
    'USER',
    'USERNAME',
    'SHELL',
    'COMSPEC',
    'SYSTEMROOT',
    'WINDIR',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TEMP',
    'TMP',
  ];

  const result: Record<string, string> = {};
  for (const key of safeKeys) {
    if (process.env[key]) {
      result[key] = process.env[key]!;
    }
  }
  return result;
}

export function createEnvironmentScanner(runner?: CommandRunner) {
  return {
    async scan(options: Omit<EnvironmentScannerOptions, 'runner'> = {}): Promise<EnvironmentInfo> {
      return scanEnvironment({ ...options, runner: runner ?? createCommandRunner() });
    },
  };
}

export function createMockEnvironmentScanner(responses: Map<string, CommandResult>) {
  const mockRunner = createMockCommandRunner(responses);
  return {
    async scan(): Promise<EnvironmentInfo> {
      return scanEnvironment({ runner: mockRunner });
    },
  };
}

export function formatEnvironmentSummary(info: EnvironmentInfo): string {
  const lines: string[] = [];
  lines.push('ResolveIt Environment Intelligence');
  lines.push('');

  lines.push('OS');
  lines.push(`  ${formatOSInfo(info.os)} (${info.os.platform} ${info.os.architecture})`);
  if (info.os.hostname) {
    lines.push(`  Hostname: ${info.os.hostname}`);
  }
  if (info.os.shell) {
    lines.push(`  Shell: ${info.os.shell}`);
  }
  lines.push('');

  lines.push('Runtimes');
  for (const rt of info.runtimes) {
    const status = rt.available ? 'available' : 'missing';
    const version = rt.version ? ` ${rt.version}` : '';
    lines.push(`  ${rt.name.padEnd(12)}${version.padEnd(8)} ${status}`);
  }
  lines.push('');

  lines.push('Package Managers');
  for (const pm of info.packageManagers) {
    const status = pm.available ? 'available' : 'missing';
    const version = pm.version ? ` ${pm.version}` : '';
    lines.push(`  ${pm.name.padEnd(12)}${version.padEnd(8)} ${status}`);
  }
  lines.push('');

  lines.push('Development Tools');
  for (const tool of info.devTools) {
    const status = tool.available ? 'available' : 'missing';
    const version = tool.version ? ` ${tool.version}` : '';
    lines.push(`  ${tool.name.padEnd(12)}${version.padEnd(8)} ${status}`);
  }
  lines.push('');

  lines.push('Containers');
  const dockerStatus = info.containers.docker.available ? 'available' : 'missing';
  const dockerVersion = info.containers.docker.version ? ` ${info.containers.docker.version}` : '';
  lines.push(`  ${'Docker'.padEnd(12)}${dockerVersion.padEnd(8)} ${dockerStatus}`);
  
  const composeStatus = info.containers.dockerCompose.available ? 'available' : 'missing';
  const composeVersion = info.containers.dockerCompose.version ? ` ${info.containers.dockerCompose.version}` : '';
  lines.push(`  ${'Compose'.padEnd(12)}${composeVersion.padEnd(8)} ${composeStatus}`);
  
  if (info.containers.dockerRunning) {
    lines.push(`  Docker daemon: running`);
  }
  lines.push('');

  const summary = {
    os: `${info.os.type || info.os.platform} ${info.os.architecture}`,
    runtimesAvailable: info.runtimes.filter(r => r.available).length,
    runtimesTotal: info.runtimes.length,
    toolsAvailable: info.devTools.filter(t => t.available).length,
    toolsTotal: info.devTools.length,
    packageManagersAvailable: info.packageManagers.filter(p => p.available).length,
    packageManagersTotal: info.packageManagers.length,
    dockerAvailable: info.containers.docker.available,
    dockerRunning: info.containers.dockerRunning,
  };

  lines.push('Summary');
  lines.push(`  OS: ${summary.os}`);
  lines.push(`  Runtimes: ${summary.runtimesAvailable}/${summary.runtimesTotal} available`);
  lines.push(`  Dev Tools: ${summary.toolsAvailable}/${summary.toolsTotal} available`);
  lines.push(`  Package Managers: ${summary.packageManagersAvailable}/${summary.packageManagersTotal} available`);
  lines.push(`  Docker: ${summary.dockerAvailable ? 'yes' : 'no'} ${summary.dockerRunning ? '(running)' : ''}`);

  return lines.join('\n');
}

function formatOSInfo(info: OSInfo): string {
  const parts = [info.type || info.platform, info.release, info.version].filter(Boolean);
  return parts.join(' ') || 'Unknown OS';
}

export function environmentInfoToJSON(info: EnvironmentInfo): string {
  return JSON.stringify(info, (_key: string, value: unknown): unknown => {
    if (value instanceof Date) {
      return value.toISOString();
    }
    return value;
  }, 2);
}