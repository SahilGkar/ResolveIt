import { describe, it, expect } from 'vitest';
import { detectPackageManager, detectAllPackageManagers, type PackageManagerDefinition, PACKAGE_MANAGER_DEFINITIONS } from '../../src/environment/adapters/package-managers.js';
import { createMockCommandRunner, type CommandResult } from '../../src/environment/command-runner.js';

describe('Package manager detection', () => {
  describe('detectPackageManager', () => {
    it('should detect available package manager with version', async () => {
      const mockResponses = new Map<string, CommandResult>([
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
      const npmDef = PACKAGE_MANAGER_DEFINITIONS.find(d => d.name === 'npm')!;
      const tool = await detectPackageManager(runner, npmDef);
      
      expect(tool.available).toBe(true);
      expect(tool.name).toBe('npm');
      expect(tool.version).toBe('10.2.0');
      expect(tool.details?.associatedRuntime).toBe('Node.js');
    });

    it('should detect missing package manager', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['pnpm --version', {
          exitCode: -1,
          stdout: '',
          stderr: 'not found',
          timedOut: false,
        }],
        ['where pnpm', {
          exitCode: -1,
          stdout: '',
          stderr: 'not found',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const pnpmDef = PACKAGE_MANAGER_DEFINITIONS.find(d => d.name === 'pnpm')!;
      const tool = await detectPackageManager(runner, pnpmDef);
      
      expect(tool.available).toBe(false);
      expect(tool.details?.reason).toBe('not found in PATH');
    });

    it('should handle version regex for pip', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['pip --version', {
          exitCode: 0,
          stdout: 'pip 23.3.1 from C:\\Python\\Lib\\site-packages\\pip (python 3.11)',
          stderr: '',
          timedOut: false,
        }],
        ['where pip', {
          exitCode: 0,
          stdout: 'C:\\Python\\Scripts\\pip.exe',
          stderr: '',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const pipDef = PACKAGE_MANAGER_DEFINITIONS.find(d => d.name === 'pip')!;
      const tool = await detectPackageManager(runner, pipDef);
      
      expect(tool.available).toBe(true);
      expect(tool.version).toBe('23.3.1');
    });

    it('should handle version regex for maven', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['mvn --version', {
          exitCode: 0,
          stdout: 'Apache Maven 3.9.5 (abc123)',
          stderr: '',
          timedOut: false,
        }],
        ['where mvn', {
          exitCode: 0,
          stdout: 'C:\\Maven\\bin\\mvn.cmd',
          stderr: '',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const mavenDef = PACKAGE_MANAGER_DEFINITIONS.find(d => d.name === 'Maven')!;
      const tool = await detectPackageManager(runner, mavenDef);
      
      expect(tool.available).toBe(true);
      expect(tool.version).toBe('3.9.5');
      expect(tool.details?.associatedRuntime).toBe('Java');
    });

    it('should handle version regex for cargo', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['cargo --version', {
          exitCode: 0,
          stdout: 'cargo 1.75.0 (abc123 2023-12-01)',
          stderr: '',
          timedOut: false,
        }],
        ['where cargo', {
          exitCode: 0,
          stdout: 'C:\\.cargo\\bin\\cargo.exe',
          stderr: '',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const cargoDef = PACKAGE_MANAGER_DEFINITIONS.find(d => d.name === 'cargo')!;
      const tool = await detectPackageManager(runner, cargoDef);
      
      expect(tool.available).toBe(true);
      expect(tool.version).toBe('1.75.0');
      expect(tool.details?.associatedRuntime).toBe('Rust');
    });
  });

  describe('detectAllPackageManagers', () => {
    it('should detect multiple package managers', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['npm --version', { exitCode: 0, stdout: '10.2.0', stderr: '', timedOut: false }],
        ['where npm', { exitCode: 0, stdout: 'C:\\nodejs\\npm', stderr: '', timedOut: false }],
        ['pip --version', { exitCode: 0, stdout: 'pip 23.3.1', stderr: '', timedOut: false }],
        ['where pip', { exitCode: 0, stdout: 'C:\\Python\\Scripts\\pip.exe', stderr: '', timedOut: false }],
        // For other package managers, mock the "where" command to return not found
        ['where cargo', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['where go', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['where gem', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['where bundler', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['where composer', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['where dotnet', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['where nuget', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['where pnpm', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['where yarn', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['where pip3', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['where pipx', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['where poetry', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['where mvn', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['where gradle', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
        ['where nuget', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const tools = await detectAllPackageManagers(runner);
      
      const available = tools.filter(t => t.available);
      const missing = tools.filter(t => !t.available);
      
      expect(available.length).toBeGreaterThanOrEqual(2);
      expect(missing.length).toBeGreaterThanOrEqual(1);
      
      for (const tool of tools) {
        expect(tool.name).toBeDefined();
        expect(tool.command).toBeDefined();
        expect(typeof tool.available).toBe('boolean');
        // The details should have associatedRuntime for available tools
        if (tool.available && tool.details) {
          expect(tool.details.associatedRuntime).toBeDefined();
        }
      }
    });
  });
});