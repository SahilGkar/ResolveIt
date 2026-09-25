import { describe, it, expect } from 'vitest';
import { detectTool, detectAllDevTools, type ToolDefinition, DEV_TOOL_DEFINITIONS } from '../../src/environment/adapters/tools.js';
import { createMockCommandRunner, type CommandResult } from '../../src/environment/command-runner.js';

describe('Development tools detection', () => {
  describe('detectTool', () => {
    it('should detect available tool with version', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['git --version', {
          exitCode: 0,
          stdout: 'git version 2.43.0',
          stderr: '',
          timedOut: false,
        }],
        ['where git', {
          exitCode: 0,
          stdout: 'C:\\Program Files\\Git\\cmd\\git.exe',
          stderr: '',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const gitDef = DEV_TOOL_DEFINITIONS.find(d => d.name === 'Git')!;
      const tool = await detectTool(runner, gitDef);
      
      expect(tool.available).toBe(true);
      expect(tool.name).toBe('Git');
      // The regex extracts "2.43.0" not "2.43.0.windows.1"
      expect(tool.version).toBe('2.43.0');
      expect(tool.path).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    });

    it('should detect missing tool', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['cmake --version', {
          exitCode: -1,
          stdout: '',
          stderr: 'not found',
          timedOut: false,
        }],
        ['where cmake', {
          exitCode: -1,
          stdout: '',
          stderr: 'not found',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const cmakeDef = DEV_TOOL_DEFINITIONS.find(d => d.name === 'CMake')!;
      const tool = await detectTool(runner, cmakeDef);
      
      expect(tool.available).toBe(false);
      expect(tool.details?.reason).toBe('not found in PATH');
    });

    it('should handle failed detection gracefully', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['docker --version', {
          exitCode: 1,
          stdout: '',
          stderr: 'error',
          timedOut: false,
        }],
        ['where docker', {
          exitCode: -1,
          stdout: '',
          stderr: 'not found',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const dockerDef = DEV_TOOL_DEFINITIONS.find(d => d.name === 'Docker')!;
      const tool = await detectTool(runner, dockerDef);
      
      expect(tool.available).toBe(false);
    });

    it('should try aliases when primary command fails', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['docker compose version', {
          exitCode: 0,
          stdout: 'Docker Compose version 2.24.0',
          stderr: '',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const dockerComposeV2Def = DEV_TOOL_DEFINITIONS.find(d => d.name === 'Docker Compose (v2)')!;
      const tool = await detectTool(runner, dockerComposeV2Def);
      
      expect(tool.available).toBe(true);
      expect(tool.command).toBe('docker');
      // The regex extracts "2.24.0" not "v2.24.0"
      expect(tool.version).toBe('2.24.0');
    });
  });

  describe('detectAllDevTools', () => {
    it('should detect multiple tools', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['git --version', { exitCode: 0, stdout: 'git version 2.43.0', stderr: '', timedOut: false }],
        ['where git', { exitCode: 0, stdout: 'C:\\Git\\git.exe', stderr: '', timedOut: false }],
        ['docker --version', { exitCode: 0, stdout: 'Docker version 24.0.0', stderr: '', timedOut: false }],
        ['where docker', { exitCode: 0, stdout: 'C:\\Docker\\docker.exe', stderr: '', timedOut: false }],
        ['cmake --version', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['where cmake', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['make --version', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['where make', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const tools = await detectAllDevTools(runner);
      
      const available = tools.filter(t => t.available);
      const missing = tools.filter(t => !t.available);
      
      expect(available.length).toBeGreaterThanOrEqual(2);
      expect(missing.length).toBeGreaterThanOrEqual(1);
      
      for (const tool of tools) {
        expect(tool.name).toBeDefined();
        expect(tool.command).toBeDefined();
        expect(typeof tool.available).toBe('boolean');
      }
    });
  });
});