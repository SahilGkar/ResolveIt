import { describe, it, expect } from 'vitest';
import { detectContainers } from '../../src/environment/adapters/containers.js';
import { createMockCommandRunner, type CommandResult } from '../../src/environment/command-runner.js';

describe('Docker/Container detection', () => {
  describe('detectContainers', () => {
    it('should detect Docker available', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['docker --version', {
          exitCode: 0,
          stdout: 'Docker version 24.0.0, build abc123',
          stderr: '',
          timedOut: false,
        }],
        ['where docker', {
          exitCode: 0,
          stdout: 'C:\\Docker\\docker.exe',
          stderr: '',
          timedOut: false,
        }],
        ['docker compose version', {
          exitCode: 0,
          stdout: 'Docker Compose version v2.24.0',
          stderr: '',
          timedOut: false,
        }],
        ['docker info', {
          exitCode: 0,
          stdout: 'Containers: 5\nImages: 10',
          stderr: '',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const containers = await detectContainers(runner);
      
      expect(containers.docker.available).toBe(true);
      expect(containers.docker.version).toBe('24.0.0');
      expect(containers.dockerCompose.available).toBe(true);
      // The regex extracts "2.24.0" not "v2.24.0"
      expect(containers.dockerCompose.version).toBe('2.24.0');
      expect(containers.dockerCompose.details?.versionType).toBe('v2');
      expect(containers.dockerRunning).toBe(true);
    });

    it('should detect Docker missing', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['docker --version', {
          exitCode: -1,
          stdout: '',
          stderr: 'not found',
          timedOut: false,
        }],
        ['where docker', {
          exitCode: -1,
          stdout: '',
          stderr: 'not found',
          timedOut: false,
        }],
        ['docker compose version', {
          exitCode: -1,
          stdout: '',
          stderr: 'not found',
          timedOut: false,
        }],
        ['docker-compose --version', {
          exitCode: -1,
          stdout: '',
          stderr: 'not found',
          timedOut: false,
        }],
        ['where docker-compose', {
          exitCode: -1,
          stdout: '',
          stderr: 'not found',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const containers = await detectContainers(runner);
      
      expect(containers.docker.available).toBe(false);
      expect(containers.dockerCompose.available).toBe(false);
      expect(containers.dockerRunning).toBe(false);
    });

    it('should detect legacy docker-compose', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['docker --version', {
          exitCode: 0,
          stdout: 'Docker version 20.10.0',
          stderr: '',
          timedOut: false,
        }],
        ['where docker', {
          exitCode: 0,
          stdout: 'C:\\Docker\\docker.exe',
          stderr: '',
          timedOut: false,
        }],
        ['docker compose version', {
          exitCode: 1,
          stdout: '',
          stderr: 'compose not available',
          timedOut: false,
        }],
        ['docker-compose --version', {
          exitCode: 0,
          stdout: 'docker-compose version 1.29.2',
          stderr: '',
          timedOut: false,
        }],
        ['where docker-compose', {
          exitCode: 0,
          stdout: 'C:\\Docker\\docker-compose.exe',
          stderr: '',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const containers = await detectContainers(runner);
      
      expect(containers.docker.available).toBe(true);
      expect(containers.dockerCompose.available).toBe(true);
      expect(containers.dockerCompose.command).toBe('docker-compose');
      expect(containers.dockerCompose.details?.versionType).toBe('legacy');
    });

    it('should detect Docker daemon unavailable', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['docker --version', {
          exitCode: 0,
          stdout: 'Docker version 24.0.0',
          stderr: '',
          timedOut: false,
        }],
        ['where docker', {
          exitCode: 0,
          stdout: 'C:\\Docker\\docker.exe',
          stderr: '',
          timedOut: false,
        }],
        ['docker compose version', {
          exitCode: 0,
          stdout: 'Docker Compose version v2.24.0',
          stderr: '',
          timedOut: false,
        }],
        ['docker info', {
          exitCode: 1,
          stdout: '',
          stderr: 'Cannot connect to the Docker daemon',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const containers = await detectContainers(runner);
      
      expect(containers.docker.available).toBe(true);
      expect(containers.dockerCompose.available).toBe(true);
      expect(containers.dockerRunning).toBe(false);
    });

    it('should get Docker info when available', async () => {
      const mockResponses = new Map<string, CommandResult>([
        ['docker --version', {
          exitCode: 0,
          stdout: 'Docker version 24.0.0',
          stderr: '',
          timedOut: false,
        }],
        ['where docker', {
          exitCode: 0,
          stdout: 'C:\\Docker\\docker.exe',
          stderr: '',
          timedOut: false,
        }],
        ['docker compose version', {
          exitCode: 0,
          stdout: 'Docker Compose version v2.24.0',
          stderr: '',
          timedOut: false,
        }],
        ['docker info', {
          exitCode: 0,
          stdout: 'Containers: 5',
          stderr: '',
          timedOut: false,
        }],
        ['docker info --format {{json .}}', {
          exitCode: 0,
          stdout: '{"Containers":5,"Images":10,"Driver":"overlay2"}',
          stderr: '',
          timedOut: false,
        }],
      ]);
      
      const runner = createMockCommandRunner(mockResponses);
      const containers = await detectContainers(runner);
      
      expect(containers.dockerInfo).toBeDefined();
      expect(containers.dockerInfo!.Containers).toBe(5);
      expect(containers.dockerInfo!.Images).toBe(10);
    });
  });
});