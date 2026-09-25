import { describe, it, expect } from 'vitest';
import { scanEnvironment, environmentInfoToJSON, formatEnvironmentSummary } from '../../src/environment/index.js';
import { createMockCommandRunner, type CommandResult, type CommandRunner } from '../../src/environment/command-runner.js';
import { type EnvironmentInfo, type ToolInstallation } from '../../src/core/models.js';

describe('Environment serialization', () => {
  const createMockRunner = (): CommandRunner => {
    const responses = new Map<string, CommandResult>([
      ['sw_vers -productVersion', { exitCode: 0, stdout: '14.4.1', stderr: '', timedOut: false }],
      ['python --version', { exitCode: 0, stdout: 'Python 3.11.5', stderr: '', timedOut: false }],
      ['where python', { exitCode: 0, stdout: '/usr/bin/python3', stderr: '', timedOut: false }],
      ['pip --version', { exitCode: 0, stdout: 'pip 23.3.1', stderr: '', timedOut: false }],
      ['where pip', { exitCode: 0, stdout: '/usr/bin/pip3', stderr: '', timedOut: false }],
      ['node --version', { exitCode: 0, stdout: 'v20.10.0', stderr: '', timedOut: false }],
      ['where node', { exitCode: 0, stdout: '/usr/bin/node', stderr: '', timedOut: false }],
      ['npm --version', { exitCode: 0, stdout: '10.2.0', stderr: '', timedOut: false }],
      ['where npm', { exitCode: 0, stdout: '/usr/bin/npm', stderr: '', timedOut: false }],
      ['java -version', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['where java', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['git --version', { exitCode: 0, stdout: 'git version 2.43.0', stderr: '', timedOut: false }],
      ['where git', { exitCode: 0, stdout: '/usr/bin/git', stderr: '', timedOut: false }],
      ['docker --version', { exitCode: 0, stdout: 'Docker version 24.0.0', stderr: '', timedOut: false }],
      ['where docker', { exitCode: 0, stdout: '/usr/bin/docker', stderr: '', timedOut: false }],
      ['docker compose version', { exitCode: 0, stdout: 'Docker Compose version v2.24.0', stderr: '', timedOut: false }],
      ['docker info', { exitCode: 0, stdout: 'Containers: 5', stderr: '', timedOut: false }],
      ['docker info --format {{json .}}', { exitCode: 0, stdout: '{"Containers":5}', stderr: '', timedOut: false }],
      ['docker compose version', { exitCode: 0, stdout: 'Docker Compose version v2.24.0', stderr: '', timedOut: false }],
      ['go version', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['where go', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['rustc --version', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['where rustc', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['cmake --version', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['where cmake', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
    ]);
    return createMockCommandRunner(responses);
  };

  it('should serialize EnvironmentInfo to JSON', async () => {
    const runner = createMockRunner();
    const env = await scanEnvironment({ runner });
    
    const json = environmentInfoToJSON(env);
    
    expect(json).toBeDefined();
    expect(typeof json).toBe('string');
    
    // Should be valid JSON
    const parsed = JSON.parse(json);
    expect(parsed).toBeDefined();
  });

  it('should contain all expected top-level fields in JSON', async () => {
    const runner = createMockRunner();
    const env = await scanEnvironment({ runner });
    
    const json = environmentInfoToJSON(env);
    const parsed = JSON.parse(json);
    
    expect(parsed.os).toBeDefined();
    expect(parsed.runtimes).toBeInstanceOf(Array);
    expect(parsed.devTools).toBeInstanceOf(Array);
    expect(parsed.packageManagers).toBeInstanceOf(Array);
    expect(parsed.containers).toBeDefined();
    expect(parsed.environmentVariables).toBeDefined();
    expect(parsed.scannedAt).toBeDefined();
  });

  it('should have correct runtime structure in JSON', async () => {
    const runner = createMockRunner();
    const env = await scanEnvironment({ runner });
    
    const json = environmentInfoToJSON(env);
    const parsed = JSON.parse(json);
    
    expect(parsed.runtimes.length).toBeGreaterThan(0);
    
    for (const rt of parsed.runtimes) {
      expect(rt.name).toBeDefined();
      expect(rt.command).toBeDefined();
      expect(typeof rt.available).toBe('boolean');
      if (rt.available) {
        expect(rt.version).toBeDefined();
        expect(rt.path).toBeDefined();
      }
    }
  });

  it('should have correct container structure in JSON', async () => {
    const runner = createMockRunner();
    const env = await scanEnvironment({ runner });
    
    const json = environmentInfoToJSON(env);
    const parsed = JSON.parse(json);
    
    expect(parsed.containers.docker).toBeDefined();
    expect(parsed.containers.dockerCompose).toBeDefined();
    expect(typeof parsed.containers.dockerRunning).toBe('boolean');
    expect(parsed.containers.docker.available).toBe(true);
    expect(parsed.containers.dockerCompose.available).toBe(true);
  });

  it('should serialize dates as ISO strings', async () => {
    const runner = createMockRunner();
    const env = await scanEnvironment({ runner });
    
    const json = environmentInfoToJSON(env);
    const parsed = JSON.parse(json);
    
    // scannedAt should be ISO string
    expect(parsed.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('should produce human-readable summary', async () => {
    const runner = createMockRunner();
    const env = await scanEnvironment({ runner });
    
    const summary = formatEnvironmentSummary(env);
    
    expect(summary).toContain('ResolveIt Environment Intelligence');
    expect(summary).toContain('OS');
    expect(summary).toContain('Runtimes');
    expect(summary).toContain('Package Managers');
    expect(summary).toContain('Development Tools');
    expect(summary).toContain('Containers');
    expect(summary).toContain('Summary');
    expect(summary).toContain('available');
    expect(summary).toContain('missing');
  });

  it('should handle missing fields gracefully', async () => {
    const minimalEnv: EnvironmentInfo = {
      os: {
        platform: 'linux',
        architecture: 'x64',
        hostname: 'test',
        type: 'Linux',
      },
      runtimes: [
        { name: 'Python', command: 'python', available: false, source: 'command', details: { reason: 'not found' } },
      ] as ToolInstallation[],
      devTools: [
        { name: 'Git', command: 'git', available: false, source: 'command', details: { reason: 'not found' } },
      ] as ToolInstallation[],
      packageManagers: [
        { name: 'npm', command: 'npm', available: false, source: 'command', details: { reason: 'not found', associatedRuntime: 'Node.js' } },
      ] as ToolInstallation[],
      containers: {
        docker: { name: 'Docker', command: 'docker', available: false, source: 'command', details: { reason: 'not found' } },
        dockerCompose: { name: 'Docker Compose', command: 'docker-compose', available: false, source: 'command', details: { reason: 'not found' } },
        dockerRunning: false,
      },
      environmentVariables: { PATH: '/usr/bin' },
      scannedAt: new Date('2024-01-01T00:00:00.000Z'),
    };
    
    const json = environmentInfoToJSON(minimalEnv);
    const parsed = JSON.parse(json);
    
    expect(parsed.os.platform).toBe('linux');
    expect(parsed.runtimes[0].available).toBe(false);
    expect(parsed.scannedAt).toBe('2024-01-01T00:00:00.000Z');
  });

  it('should be able to round-trip parse and serialize', async () => {
    const runner = createMockRunner();
    const env = await scanEnvironment({ runner });
    
    const json = environmentInfoToJSON(env);
    const parsed = JSON.parse(json);
    const reparsed = JSON.parse(JSON.stringify(parsed));
    
    expect(reparsed.os.platform).toBe(parsed.os.platform);
    expect(reparsed.runtimes.length).toBe(parsed.runtimes.length);
  });
});