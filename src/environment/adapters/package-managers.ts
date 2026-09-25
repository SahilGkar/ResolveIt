import type { ToolInstallation } from '../../core/models.js';
import type { CommandRunner } from '../command-runner.js';

export interface PackageManagerDefinition {
  readonly name: string;
  readonly command: string;
  readonly versionArg: string;
  readonly versionRegex?: RegExp;
  readonly aliases?: ReadonlyArray<string>;
  readonly associatedRuntime?: string;
}

export const PACKAGE_MANAGER_DEFINITIONS: ReadonlyArray<PackageManagerDefinition> = [
  { name: 'npm', command: 'npm', versionArg: '--version', associatedRuntime: 'Node.js' },
  { name: 'pnpm', command: 'pnpm', versionArg: '--version', associatedRuntime: 'Node.js' },
  { name: 'yarn', command: 'yarn', versionArg: '--version', associatedRuntime: 'Node.js' },
  { name: 'pip', command: 'pip', versionArg: '--version', versionRegex: /pip\s+(\d+\.\d+(?:\.\d+)?)/, associatedRuntime: 'Python' },
  { name: 'pip3', command: 'pip3', versionArg: '--version', versionRegex: /pip\s+(\d+\.\d+(?:\.\d+)?)/, associatedRuntime: 'Python' },
  { name: 'pipx', command: 'pipx', versionArg: '--version', associatedRuntime: 'Python' },
  { name: 'Poetry', command: 'poetry', versionArg: '--version', versionRegex: /Poetry\s+(\d+\.\d+\.\d+)/, associatedRuntime: 'Python' },
  { name: 'Maven', command: 'mvn', versionArg: '--version', versionRegex: /Apache Maven\s+(\d+\.\d+\.\d+)/, associatedRuntime: 'Java' },
  { name: 'Gradle', command: 'gradle', versionArg: '--version', versionRegex: /Gradle\s+(\d+\.\d+(?:\.\d+)?)/, associatedRuntime: 'Java' },
  { name: 'cargo', command: 'cargo', versionArg: '--version', versionRegex: /cargo\s+(\d+\.\d+\.\d+)/, associatedRuntime: 'Rust' },
  { name: 'go', command: 'go', versionArg: 'version', versionRegex: /go version go(\d+\.\d+(?:\.\d+)?)/, associatedRuntime: 'Go' },
  { name: 'gem', command: 'gem', versionArg: '--version', versionRegex: /(\d+\.\d+\.\d+)/, associatedRuntime: 'Ruby' },
  { name: 'bundler', command: 'bundler', versionArg: '--version', versionRegex: /Bundler version\s+(\d+\.\d+\.\d+)/, associatedRuntime: 'Ruby' },
  { name: 'composer', command: 'composer', versionArg: '--version', versionRegex: /Composer version\s+(\d+\.\d+\.\d+)/, associatedRuntime: 'PHP' },
  { name: 'dotnet', command: 'dotnet', versionArg: '--version', versionRegex: /(\d+\.\d+\.\d+)/, associatedRuntime: '.NET' },
  { name: 'nuget', command: 'nuget', versionArg: 'help', versionRegex: /(\d+\.\d+\.\d+)/, associatedRuntime: '.NET' },
];

export async function detectPackageManager(
  runner: CommandRunner,
  definition: PackageManagerDefinition
): Promise<ToolInstallation> {
  const commandsToTry = [definition.command, ...(definition.aliases || [])];

  for (const cmd of commandsToTry) {
    const result = await runner.run(cmd, [definition.versionArg]);
    if (result.exitCode === 0) {
      const version = extractVersion(result.stdout + result.stderr, definition.versionRegex);
      const path = await findCommandPath(runner, cmd);

      return {
        name: definition.name,
        command: cmd,
        version,
        path,
        available: true,
        source: 'command',
        details: { associatedRuntime: definition.associatedRuntime },
      };
    }
  }

  return createMissingTool(definition.name, definition.command);
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
        if (parts.length > 0 && parts[0]) {
          return parts[0].trim();
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

export async function detectAllPackageManagers(runner: CommandRunner): Promise<ToolInstallation[]> {
  const results: ToolInstallation[] = [];
  for (const definition of PACKAGE_MANAGER_DEFINITIONS) {
    const tool = await detectPackageManager(runner, definition);
    results.push(tool);
  }
  return results;
}