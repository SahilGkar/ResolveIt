import type { ToolInstallation } from '../../core/models.js';
import type { CommandRunner } from '../command-runner.js';

export interface ToolDefinition {
  readonly name: string;
  readonly command: string;
  readonly versionArg: string;
  readonly versionRegex?: RegExp;
  readonly aliases?: ReadonlyArray<string>;
}

export const DEV_TOOL_DEFINITIONS: ReadonlyArray<ToolDefinition> = [
  { name: 'Git', command: 'git', versionArg: '--version', versionRegex: /git version\s+(\d+\.\d+\.\d+)/ },
  { name: 'Docker', command: 'docker', versionArg: '--version', versionRegex: /Docker version\s+(\d+\.\d+\.\d+)/ },
  { name: 'Docker Compose (v2)', command: 'docker', versionArg: 'compose version', versionRegex: /Docker Compose version\s+(\d+\.\d+\.\d+)/, aliases: ['docker compose'] },
  { name: 'Docker Compose (legacy)', command: 'docker-compose', versionArg: '--version', versionRegex: /docker-compose version\s+(\d+\.\d+\.\d+)/ },
  { name: 'CMake', command: 'cmake', versionArg: '--version', versionRegex: /cmake version\s+(\d+\.\d+\.\d+)/ },
  { name: 'Make', command: 'make', versionArg: '--version', versionRegex: /GNU Make\s+(\d+\.\d+)/ },
  { name: 'Ninja', command: 'ninja', versionArg: '--version', versionRegex: /(\d+\.\d+\.\d+)/ },
  { name: 'Meson', command: 'meson', versionArg: '--version', versionRegex: /(\d+\.\d+\.\d+)/ },
  { name: 'Bazel', command: 'bazel', versionArg: '--version', versionRegex: /(\d+\.\d+\.\d+)/ },
  { name: 'Gradle', command: 'gradle', versionArg: '--version', versionRegex: /Gradle\s+(\d+\.\d+(?:\.\d+)?)/ },
  { name: 'Maven', command: 'mvn', versionArg: '--version', versionRegex: /Apache Maven\s+(\d+\.\d+\.\d+)/ },
  { name: 'Cargo', command: 'cargo', versionArg: '--version', versionRegex: /cargo\s+(\d+\.\d+\.\d+)/ },
  { name: 'Go', command: 'go', versionArg: 'version', versionRegex: /go version go(\d+\.\d+(?:\.\d+)?)/ },
  { name: 'npm', command: 'npm', versionArg: '--version' },
  { name: 'pnpm', command: 'pnpm', versionArg: '--version' },
  { name: 'Yarn', command: 'yarn', versionArg: '--version' },
  { name: 'pip', command: 'pip', versionArg: '--version', versionRegex: /pip\s+(\d+\.\d+(?:\.\d+)?)/ },
  { name: 'pip3', command: 'pip3', versionArg: '--version', versionRegex: /pip\s+(\d+\.\d+(?:\.\d+)?)/ },
  { name: 'Poetry', command: 'poetry', versionArg: '--version', versionRegex: /Poetry\s+(\d+\.\d+\.\d+)/ },
  { name: 'Bundler', command: 'bundler', versionArg: '--version', versionRegex: /Bundler version\s+(\d+\.\d+\.\d+)/ },
  { name: 'Gem', command: 'gem', versionArg: '--version', versionRegex: /(\d+\.\d+\.\d+)/ },
  { name: 'Composer', command: 'composer', versionArg: '--version', versionRegex: /Composer version\s+(\d+\.\d+\.\d+)/ },
  { name: 'NuGet', command: 'nuget', versionArg: 'help', versionRegex: /(\d+\.\d+\.\d+)/ },
];

export async function detectTool(runner: CommandRunner, definition: ToolDefinition): Promise<ToolInstallation> {
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
        details: {},
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

export async function detectAllDevTools(runner: CommandRunner): Promise<ToolInstallation[]> {
  const results: ToolInstallation[] = [];
  for (const definition of DEV_TOOL_DEFINITIONS) {
    const tool = await detectTool(runner, definition);
    results.push(tool);
  }
  return results;
}