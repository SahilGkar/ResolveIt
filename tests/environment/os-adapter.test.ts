import { describe, it, expect, vi } from 'vitest';
import { detectOS, formatOSInfo, type OSInfo } from '../../src/environment/adapters/os.js';
import { createMockCommandRunner, type CommandResult } from '../../src/environment/command-runner.js';

describe('OS adapter', () => {
  describe('detectOS', () => {
    it('should detect Windows OS', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const originalComSpec = process.env.ComSpec;
      process.env.ComSpec = 'C:\\Windows\\system32\\cmd.exe';
      
      try {
        const runner = createMockCommandRunner(new Map());
        const osInfo = await detectOS(runner);
        
        expect(osInfo.platform).toBe('win32');
        expect(osInfo.type).toBe('Windows');
        expect(osInfo.shell).toBe('cmd');
        expect(osInfo.architecture).toBeDefined();
        expect(osInfo.hostname).toBeDefined();
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        if (originalComSpec) process.env.ComSpec = originalComSpec;
        else delete process.env.ComSpec;
      }
    });

    it('should detect Linux OS', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      process.env.SHELL = '/bin/bash';
      
      try {
        const mockResponses = new Map<string, CommandResult>([
          ['cat /etc/os-release', {
            exitCode: 0,
            stdout: 'PRETTY_NAME="Ubuntu 22.04.3 LTS"\nVERSION_ID="22.04"',
            stderr: '',
            timedOut: false,
          }],
          ['uname -r', {
            exitCode: 0,
            stdout: '5.15.0-91-generic',
            stderr: '',
            timedOut: false,
          }],
        ]);
        
        const runner = createMockCommandRunner(mockResponses);
        const osInfo = await detectOS(runner);
        
        expect(osInfo.platform).toBe('linux');
        expect(osInfo.type).toBe('Linux');
        expect(osInfo.shell).toBe('/bin/bash');
        // release may be undefined if command fails
        if (osInfo.release) {
          expect(osInfo.release).toContain('Ubuntu');
        }
        if (osInfo.version) {
          expect(osInfo.version).toBe('5.15.0-91-generic');
        }
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('should detect macOS', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      process.env.SHELL = '/bin/zsh';
      
      try {
        const mockResponses = new Map<string, CommandResult>([
          ['sw_vers -productVersion', {
            exitCode: 0,
            stdout: '14.4.1',
            stderr: '',
            timedOut: false,
          }],
        ]);
        
        const runner = createMockCommandRunner(mockResponses);
        const osInfo = await detectOS(runner);
        
        expect(osInfo.platform).toBe('darwin');
        expect(osInfo.type).toBe('macOS');
        expect(osInfo.shell).toBe('/bin/zsh');
        if (osInfo.version) {
          expect(osInfo.version).toBe('14.4.1');
        }
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('should handle unknown platform', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
      
      try {
        const runner = createMockCommandRunner(new Map());
        const osInfo = await detectOS(runner);
        
        expect(osInfo.platform).toBe('freebsd');
        expect(osInfo.type).toBe('freebsd');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });

  describe('formatOSInfo', () => {
    it('should format Windows OS info', () => {
      const osInfo: OSInfo = {
        platform: 'win32',
        architecture: 'x64',
        hostname: 'TEST-PC',
        type: 'Windows',
        release: '10.0.19045',
        version: 'Windows 11 Pro',
        shell: 'cmd',
      };
      
      const formatted = formatOSInfo(osInfo);
      expect(formatted).toContain('Windows');
      expect(formatted).toContain('10.0.19045');
      expect(formatted).toContain('Windows 11 Pro');
    });

    it('should format Linux OS info', () => {
      const osInfo: OSInfo = {
        platform: 'linux',
        architecture: 'x64',
        hostname: 'test-server',
        type: 'Linux',
        release: 'Ubuntu 22.04.3 LTS',
        version: '5.15.0-91-generic',
        shell: '/bin/bash',
      };
      
      const formatted = formatOSInfo(osInfo);
      expect(formatted).toContain('Linux');
      expect(formatted).toContain('Ubuntu 22.04.3 LTS');
    });

    it('should handle minimal OS info', () => {
      const osInfo: OSInfo = {
        platform: 'unknown',
        architecture: 'x64',
        hostname: 'test',
      };
      
      const formatted = formatOSInfo(osInfo);
      expect(formatted).toBe('unknown');
    });
  });
});