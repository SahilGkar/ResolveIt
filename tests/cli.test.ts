import { describe, it, expect, vi } from 'vitest';
import { program, runCli } from '../src/cli/index.js';
import { version } from '../src/version.js';

describe('CLI', () => {
  it('should have version command', () => {
    const versionCmd = program.commands.find(c => c.name() === 'version');
    expect(versionCmd).toBeDefined();
  });

  it('should have help command', () => {
    const helpCmd = program.commands.find(c => c.name() === 'help');
    expect(helpCmd).toBeDefined();
  });

  it('should parse version', () => {
    expect(version).toBe('0.0.1');
  });

  it('should not throw for the help option', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(() => runCli(['--help'])).not.toThrow();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});
