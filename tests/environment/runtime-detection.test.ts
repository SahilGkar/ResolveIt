import { describe, it, expect, vi } from 'vitest';
import { detectRuntime, detectAllRuntimes, type RuntimeInfo, RUNTIME_DEFINITIONS } from '../../src/environment/adapters/runtime.js';
import { createMockCommandRunner, type CommandResult } from '../../src/environment/command-runner.js';

describe('Runtime detection', () => {
  describe('detectRuntime', () => {
    it('should detect available runtime with version', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['python --version', {
          exitCode: 0,
          stdout: 'Python 3.11.5',
          stderr: '',
          timedOut: false,
        }],
        ['where python', {
          exitCode: 0,
          stdout: 'C:\\Python311\\python.exe',
          stderr: '',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const pythonDef = RUNTIME_DEFINITIONS.find(d => d.name === 'Python')!;
      const tool = await detectRuntime(runner, pythonDef);
      
      expect(tool.available).toBe(true);
      expect(tool.name).toBe('Python');
      expect(tool.version).toBe('3.11.5');
      expect(tool.path).toBe('C:\\Python311\\python.exe');
      expect(tool.command).toBe('python');
    });

    it('should detect runtime with stderr version output (Java style)', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['java -version', {
          exitCode: 0,
          stdout: '',
          stderr: 'openjdk version "21.0.1" 2023-10-17',
          timedOut: false,
        }],
        ['where java', {
          exitCode: 0,
          stdout: 'C:\\Java\\jdk-21\\bin\\java.exe',
          stderr: '',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const javaDef = RUNTIME_DEFINITIONS.find(d => d.name === 'Java')!;
      const tool = await detectRuntime(runner, javaDef);
      
      expect(tool.available).toBe(true);
      expect(tool.name).toBe('Java');
      expect(tool.version).toBe('21.0.1');
    });

    it('should handle missing runtime', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['rustc --version', {
          exitCode: -1,
          stdout: '',
          stderr: 'command not found',
          timedOut: false,
        }],
        ['where rustc', {
          exitCode: -1,
          stdout: '',
          stderr: 'not found',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const rustDef = RUNTIME_DEFINITIONS.find(d => d.name === 'Rust')!;
      const tool = await detectRuntime(runner, rustDef);
      
      expect(tool.available).toBe(false);
      expect(tool.name).toBe('Rust');
      expect(tool.version).toBeUndefined();
      expect(tool.details?.reason).toBe('not found in PATH');
    });

    it('should handle malformed version output', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['go version', {
          exitCode: 0,
          stdout: 'go version go1.21.3 windows/amd64',
          stderr: '',
          timedOut: false,
        }],
        ['where go', {
          exitCode: 0,
          stdout: 'C:\\Go\\bin\\go.exe',
          stderr: '',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const goDef = RUNTIME_DEFINITIONS.find(d => d.name === 'Go')!;
      const tool = await detectRuntime(runner, goDef);
      
      expect(tool.available).toBe(true);
      expect(tool.version).toBe('1.21.3');
    });

    it('should try aliases when primary command fails', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['python --version', {
          exitCode: -1,
          stdout: '',
          stderr: 'not found',
          timedOut: false,
        }],
        ['python3 --version', {
          exitCode: 0,
          stdout: 'Python 3.12.0',
          stderr: '',
          timedOut: false,
        }],
        ['where python3', {
          exitCode: 0,
          stdout: '/usr/bin/python3',
          stderr: '',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const pythonDef = RUNTIME_DEFINITIONS.find(d => d.name === 'Python')!;
      const tool = await detectRuntime(runner, pythonDef);
      
      expect(tool.available).toBe(true);
      expect(tool.command).toBe('python3');
    });

    it('should detect extra related tools', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['node --version', {
          exitCode: 0,
          stdout: 'v20.10.0',
          stderr: '',
          timedOut: false,
        }],
        ['where node', {
          exitCode: 0,
          stdout: 'C:\\Program Files\\nodejs\\node.exe',
          stderr: '',
          timedOut: false,
        }],
        ['npm --version', {
          exitCode: 0,
          stdout: '10.2.0',
          stderr: '',
          timedOut: false,
        }],
        ['where npm', {
          exitCode: 0,
          stdout: 'C:\\Program Files\\nodejs\\npm',
          stderr: '',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const nodeDef = RUNTIME_DEFINITIONS.find(d => d.name === 'Node.js')!;
      const tool = await detectRuntime(runner, nodeDef);
      
      expect(tool.available).toBe(true);
      expect(tool.details?.relatedTools).toBeDefined();
      const relatedTools = tool.details!.relatedTools as any[];
      expect(relatedTools.some(t => t.name === 'npm')).toBe(true);
    });
  });

  describe('detectAllRuntimes', () => {
    it('should detect multiple runtimes', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['python --version', { exitCode: 0, stdout: 'Python 3.11.5', stderr: '', timedOut: false }],
        ['where python', { exitCode: 0, stdout: 'C:\\Python\\python.exe', stderr: '', timedOut: false }],
        ['node --version', { exitCode: 0, stdout: 'v20.10.0', stderr: '', timedOut: false }],
        ['where node', { exitCode: 0, stdout: 'C:\\nodejs\\node.exe', stderr: '', timedOut: false }],
        ['java -version', { exitCode: 0, stdout: '', stderr: 'openjdk version "21.0.1"', timedOut: false }],
        ['where java', { exitCode: 0, stdout: 'C:\\Java\\java.exe', stderr: '', timedOut: false }],
        ['go version', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['where go', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const tools = await detectAllRuntimes(runner);
      
      const available = tools.filter(t => t.available);
      const missing = tools.filter(t => !t.available);
      
      expect(available.length).toBeGreaterThanOrEqual(3);
      expect(missing.length).toBeGreaterThanOrEqual(1);
      
      // Check structure
      for (const tool of tools) {
        expect(tool.name).toBeDefined();
        expect(tool.command).toBeDefined();
        expect(typeof tool.available).toBe('boolean');
      }
    });
  });
});