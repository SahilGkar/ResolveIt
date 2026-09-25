import type { ToolInstallation } from '../../core/models.js';
import type { CommandRunner } from '../command-runner.js';

export interface RuntimeInfo {
  readonly name: string;
  readonly command: string;
  readonly aliases: ReadonlyArray<string>;
  readonly versionArg: string;
  readonly versionRegex?: RegExp;
  readonly extraChecks?: ReadonlyArray<{ command: string; args: ReadonlyArray<string> }>;
}

export const RUNTIME_DEFINITIONS: ReadonlyArray<RuntimeInfo> = [
  {
    name: 'Python',
    command: 'python',
    aliases: ['python3', 'py'],
    versionArg: '--version',
    versionRegex: /Python\s+(\d+\.\d+\.\d+)/,
    extraChecks: [
      { command: 'python', args: ['-c', 'import sys; print(sys.executable)'] },
      { command: 'pip', args: ['--version'] },
    ],
  },
  {
    name: 'Node.js',
    command: 'node',
    aliases: [],
    versionArg: '--version',
    versionRegex: /v?(\d+\.\d+\.\d+)/,
    extraChecks: [
      { command: 'npm', args: ['--version'] },
      { command: 'npx', args: ['--version'] },
      { command: 'pnpm', args: ['--version'] },
      { command: 'yarn', args: ['--version'] },
    ],
  },
  {
    name: 'TypeScript',
    command: 'tsc',
    aliases: [],
    versionArg: '--version',
    versionRegex: /Version\s+(\d+\.\d+\.\d+)/,
  },
  {
    name: 'Java',
    command: 'java',
    aliases: [],
    versionArg: '-version',
    versionRegex: /version\s+"(\d+(?:\.\d+)*)/,
    extraChecks: [
      { command: 'javac', args: ['-version'] },
      { command: 'mvn', args: ['--version'] },
      { command: 'gradle', args: ['--version'] },
    ],
  },
  {
    name: 'Go',
    command: 'go',
    aliases: [],
    versionArg: 'version',
    versionRegex: /go version go(\d+\.\d+(?:\.\d+)?)/,
  },
  {
    name: 'Rust',
    command: 'rustc',
    aliases: [],
    versionArg: '--version',
    versionRegex: /rustc\s+(\d+\.\d+\.\d+)/,
    extraChecks: [
      { command: 'cargo', args: ['--version'] },
    ],
  },
  {
    name: 'C (GCC)',
    command: 'gcc',
    aliases: [],
    versionArg: '--version',
    versionRegex: /gcc\s+\([^)]+\)\s+(\d+\.\d+\.\d+)/,
    extraChecks: [
      { command: 'g++', args: ['--version'] },
      { command: 'clang', args: ['--version'] },
      { command: 'clang++', args: ['--version'] },
    ],
  },
  {
    name: '.NET',
    command: 'dotnet',
    aliases: [],
    versionArg: '--version',
    versionRegex: /(\d+\.\d+\.\d+)/,
    extraChecks: [
      { command: 'dotnet', args: ['--list-sdks'] },
    ],
  },
  {
    name: 'Ruby',
    command: 'ruby',
    aliases: [],
    versionArg: '--version',
    versionRegex: /ruby\s+(\d+\.\d+\.\d+)/,
    extraChecks: [
      { command: 'gem', args: ['--version'] },
      { command: 'bundler', args: ['--version'] },
    ],
  },
  {
    name: 'PHP',
    command: 'php',
    aliases: [],
    versionArg: '--version',
    versionRegex: /PHP\s+(\d+\.\d+\.\d+)/,
    extraChecks: [
      { command: 'composer', args: ['--version'] },
    ],
  },
  {
    name: 'Kotlin',
    command: 'kotlinc',
    aliases: ['kotlin'],
    versionArg: '-version',
    versionRegex: /kotlinc-jvm\s+(\d+\.\d+\.\d+)/,
  },
  {
    name: 'Swift',
    command: 'swift',
    aliases: [],
    versionArg: '--version',
    versionRegex: /swift-version\s+(\d+\.\d+(?:\.\d+)?)/,
  },
  {
    name: 'Dart',
    command: 'dart',
    aliases: [],
    versionArg: '--version',
    versionRegex: /Dart SDK version:\s+(\d+\.\d+\.\d+)/,
  },
  {
    name: 'R',
    command: 'R',
    aliases: ['Rscript'],
    versionArg: '--version',
    versionRegex: /R version\s+(\d+\.\d+\.\d+)/,
  },
  {
    name: 'Lua',
    command: 'lua',
    aliases: ['luajit'],
    versionArg: '-v',
    versionRegex: /Lua\s+(\d+\.\d+\.\d+)/,
  },
];

export async function detectRuntime(
  runner: CommandRunner,
  definition: RuntimeInfo
): Promise<ToolInstallation> {
  const commandsToTry = [definition.command, ...definition.aliases];

  for (const cmd of commandsToTry) {
    const result = await runner.run(cmd, [definition.versionArg]);
    if (result.exitCode === 0) {
      const version = extractVersion(result.stdout + result.stderr, definition.versionRegex);
      const path = await findCommandPath(runner, cmd);

      const baseTool: ToolInstallation = {
        name: definition.name,
        command: cmd,
        version,
        path,
        available: true,
        source: 'command',
        details: {},
      };

      if (definition.extraChecks) {
        const relatedTools: ToolInstallation[] = [];
        for (const check of definition.extraChecks) {
          const related = await detectRelatedTool(runner, check.command, check.args);
          if (related.available) {
            relatedTools.push(related);
          }
        }
        if (relatedTools.length > 0) {
          return {
            ...baseTool,
            details: { relatedTools },
          };
        }
      }

      return baseTool;
    }
  }

  return createMissingTool(definition.name, definition.command);
}

async function detectRelatedTool(
  runner: CommandRunner,
  command: string,
  args: ReadonlyArray<string>
): Promise<ToolInstallation> {
  const result = await runner.run(command, args);
  if (result.exitCode === 0) {
    const version = extractVersion(result.stdout + result.stderr);
    const path = await findCommandPath(runner, command);
    return {
      name: command,
      command,
      version,
      path,
      available: true,
      source: 'command',
      details: {},
    };
  }
  return createMissingTool(command, command);
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

export async function detectAllRuntimes(runner: CommandRunner): Promise<ToolInstallation[]> {
  const results: ToolInstallation[] = [];
  for (const definition of RUNTIME_DEFINITIONS) {
    const tool = await detectRuntime(runner, definition);
    results.push(tool);
  }
  return results;
}