export { OSInfo } from '../../core/models.js';
import type { OSInfo } from '../../core/models.js';
import type { CommandRunner } from '../command-runner.js';
import { hostname, release, version } from 'os';

export async function detectOS(_runner: CommandRunner): Promise<OSInfo> {
  const platform = process.platform;
  const architecture = process.arch;
  const hostnameStr = hostname();

  const baseInfo = {
    platform,
    architecture,
    hostname: hostnameStr,
    release: undefined as string | undefined,
    version: undefined as string | undefined,
    type: undefined as string | undefined,
    shell: undefined as string | undefined,
  };

  if (platform === 'win32') {
    return {
      ...baseInfo,
      release: release(),
      version: version(),
      type: 'Windows',
      shell: process.env.ComSpec ? 'cmd' : undefined,
    };
  } else if (platform === 'darwin') {
    return {
      ...baseInfo,
      release: release(),
      version: await getMacOSVersion(),
      type: 'macOS',
      shell: process.env.SHELL,
    };
  } else if (platform === 'linux') {
    return {
      ...baseInfo,
      release: await getLinuxRelease(),
      version: await getLinuxVersion(),
      type: 'Linux',
      shell: process.env.SHELL,
    };
  } else {
    return {
      ...baseInfo,
      type: platform,
    };
  }
}

async function getMacOSVersion(): Promise<string | undefined> {
  try {
    const { createCommandRunner } = await import('../command-runner.js');
    const runner = createCommandRunner();
    const result = await runner.run('sw_vers', ['-productVersion']);
    if (result.exitCode === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch {
    // Ignore
  }
  return undefined;
}

async function getLinuxRelease(): Promise<string | undefined> {
  try {
    const { createCommandRunner } = await import('../command-runner.js');
    const runner = createCommandRunner();
    const result = await runner.run('cat', ['/etc/os-release']);
    if (result.exitCode === 0 && result.stdout) {
      const lines = result.stdout.split('\n');
      for (const line of lines) {
        if (line.startsWith('PRETTY_NAME=')) {
          return line.substring('PRETTY_NAME='.length).replace(/"/g, '');
        }
      }
    }
  } catch {
    // Ignore
  }
  return undefined;
}

async function getLinuxVersion(): Promise<string | undefined> {
  try {
    const { createCommandRunner } = await import('../command-runner.js');
    const runner = createCommandRunner();
    const result = await runner.run('uname', ['-r']);
    if (result.exitCode === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch {
    // Ignore
  }
  return undefined;
}

export function formatOSInfo(info: OSInfo): string {
  const parts = [info.type || info.platform, info.release, info.version].filter(Boolean);
  return parts.join(' ') || 'Unknown OS';
}