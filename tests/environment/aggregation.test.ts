import { describe, it, expect } from 'vitest';
import { scanEnvironment } from '../../src/environment/index.js';
import { createMockCommandRunner, type CommandResult, type CommandRunner } from '../../src/environment/command-runner.js';
import { type EnvironmentInfo } from '../../src/core/models.js';

describe('Environment aggregation', () => {
  const createMockRunner = (): { runner: CommandRunner; responses: Map<string, CommandResult> } => {
    const responses = new Map<string, CommandResult>([
      // OS detection
      ['sw_vers -productVersion', { exitCode: 0, stdout: '14.4.1', stderr: '', timedOut: false }],
      
      // Python
      ['python --version', { exitCode: 0, stdout: 'Python 3.11.5', stderr: '', timedOut: false }],
      ['where python', { exitCode: 0, stdout: '/usr/bin/python3', stderr: '', timedOut: false }],
      ['pip --version', { exitCode: 0, stdout: 'pip 23.3.1', stderr: '', timedOut: false }],
      ['where pip', { exitCode: 0, stdout: '/usr/bin/pip3', stderr: '', timedOut: false }],
      
      // Node.js
      ['node --version', { exitCode: 0, stdout: 'v20.10.0', stderr: '', timedOut: false }],
      ['where node', { exitCode: 0, stdout: '/usr/bin/node', stderr: '', timedOut: false }],
      ['npm --version', { exitCode: 0, stdout: '10.2.0', stderr: '', timedOut: false }],
      ['where npm', { exitCode: 0, stdout: '/usr/bin/npm', stderr: '', timedOut: false }],
      
      // Java missing
      ['java -version', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['where java', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      
      // Git
      ['git --version', { exitCode: 0, stdout: 'git version 2.43.0', stderr: '', timedOut: false }],
      ['where git', { exitCode: 0, stdout: '/usr/bin/git', stderr: '', timedOut: false }],
      
      // Docker
      ['docker --version', { exitCode: 0, stdout: 'Docker version 24.0.0', stderr: '', timedOut: false }],
      ['where docker', { exitCode: 0, stdout: '/usr/bin/docker', stderr: '', timedOut: false }],
      ['docker compose version', { exitCode: 0, stdout: 'Docker Compose version v2.24.0', stderr: '', timedOut: false }],
      ['docker info', { exitCode: 0, stdout: 'Containers: 5', stderr: '', timedOut: false }],
      ['docker info --format {{json .}}', { exitCode: 0, stdout: '{"Containers":5}', stderr: '', timedOut: false }],
      
      // Docker compose v2
      ['docker compose version', { exitCode: 0, stdout: 'Docker Compose version v2.24.0', stderr: '', timedOut: false }],
      
      // Missing tools
      ['go version', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['where go', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['rustc --version', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['where rustc', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['cmake --version', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['where cmake', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['make --version', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['where make', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['pnpm --version', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['where pnpm', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['yarn --version', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
      ['where yarn', { exitCode: -1, stdout: '', stderr: 'not found', timedOut: false }],
    ]);
    const runner = createMockCommandRunner(responses);
    return { runner, responses };
  };

  describe('scanEnvironment', () => {
    it('should complete scan even with partial detection failures', async () => {
      const { runner } = createMockRunner();
      const env = await scanEnvironment({ runner });
      
      // Should complete without throwing
      expect(env).toBeDefined();
      expect(env.scannedAt).toBeInstanceOf(Date);
    });

    it('should represent missing tools normally (not as errors)', async () => {
      const { runner } = createMockRunner();
      const env = await scanEnvironment({ runner });
      
      // Check runtimes
      const python = env.runtimes.find(r => r.name === 'Python');
      const node = env.runtimes.find(r => r.name === 'Node.js');
      const java = env.runtimes.find(r => r.name === 'Java');
      const go = env.runtimes.find(r => r.name === 'Go');
      const rust = env.runtimes.find(r => r.name === 'Rust');
      
      expect(python!.available).toBe(true);
      expect(node!.available).toBe(true);
      expect(java!.available).toBe(false);
      expect(go!.available).toBe(false);
      
      // Missing tools should have reason
      expect(java!.details?.reason).toBe('not found in PATH');
      expect(go!.details?.reason).toBe('not found in PATH');
    });

    it('should not expose sensitive environment variables', async () => {
      const { runner } = createMockRunner();
      const env = await scanEnvironment({ runner });
      
      // Should have safe variables
      expect(env.environmentVariables.PATH).toBeDefined();
      expect(env.environmentVariables.HOME).toBeDefined();
      
      // Should not have secrets
      expect(env.environmentVariables.API_KEY).toBeUndefined();
      expect(env.environmentVariables.SECRET_KEY).toBeUndefined();
      expect(env.environmentVariables.PASSWORD).toBeUndefined();
    });

    it('should include all expected categories', async () => {
      const { runner } = createMockRunner();
      const env = await scanEnvironment({ runner });
      
      expect(env.os).toBeDefined();
      expect(env.runtimes).toBeDefined();
      expect(env.devTools).toBeDefined();
      expect(env.packageManagers).toBeDefined();
      expect(env.containers).toBeDefined();
      expect(env.environmentVariables).toBeDefined();
      expect(env.scannedAt).toBeDefined();
    });

    it('should have correct structure for each category', async () => {
      const { runner } = createMockRunner();
      const env = await scanEnvironment({ runner });
      
      // OS
      expect(env.os.platform).toBeDefined();
      expect(env.os.architecture).toBeDefined();
      expect(env.os.hostname).toBeDefined();
      
      // Runtimes
      for (const rt of env.runtimes) {
        expect(rt.name).toBeDefined();
        expect(rt.command).toBeDefined();
        expect(typeof rt.available).toBe('boolean');
      }
      
      // Dev tools
      for (const tool of env.devTools) {
        expect(tool.name).toBeDefined();
        expect(tool.command).toBeDefined();
        expect(typeof tool.available).toBe('boolean');
      }
      
      // Package managers - check available ones have details
      for (const pm of env.packageManagers) {
        expect(pm.name).toBeDefined();
        expect(pm.command).toBeDefined();
        expect(typeof pm.available).toBe('boolean');
        // Only check details for available package managers
        if (pm.available && pm.details) {
          expect(pm.details.associatedRuntime).toBeDefined();
        }
      }
      
      // Containers
      expect(env.containers.docker).toBeDefined();
      expect(env.containers.dockerCompose).toBeDefined();
      expect(typeof env.containers.dockerRunning).toBe('boolean');
    });
  });
});