import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';
import { __reset, __testState } from './vscode-mock.js';
import { activate, deactivate, COMMAND_IDS } from '../src/extension.js';

beforeEach(() => {
  __reset();
});

function mockContext(): { subscriptions: Array<{ dispose(): void }> } {
  return { subscriptions: [] };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('extension activation', () => {
  it('should register all ResolveIt commands', () => {
    activate(mockContext() as never);
    for (const id of COMMAND_IDS) {
      expect(__testState.registeredCommands.has(id)).toBe(true);
    }
    expect(__testState.registeredCommands.size).toBe(19);
  });

  it('should register no sidebar views and the status bar (single workflow panel)', () => {
    const context = mockContext();
    activate(context as never);
    expect(__testState.registeredViews).toEqual([]);
    expect(context.subscriptions.length).toBeGreaterThan(20);
    expect(__testState.workspaceFolderListeners).toHaveLength(1);
    expect(__testState.configChangeListeners).toHaveLength(1);
    expect(__testState.statusBarItems).toHaveLength(1);
    expect(__testState.statusBarItems[0]?.shown).toBe(true);
  });

  it('should log startup and load AI status without secrets', async () => {
    activate(mockContext() as never);
    await flush();
    await flush();
    expect(__testState.outputLines.some((line) => line.includes('activated'))).toBe(true);
    expect(__testState.outputLines.some((line) => line.includes('AI provider'))).toBe(true);
    expect(__testState.outputLines.join('\n')).not.toMatch(/api[_-]?key\s*[:=]/i);
  });

  it('should not crash with no workspace open', async () => {
    expect(() => activate(mockContext() as never)).not.toThrow();
    await flush();
    await flush();
    expect(__testState.outputLines.length).toBeGreaterThan(0);
  });

  it('should expose a deactivate hook', () => {
    expect(typeof deactivate).toBe('function');
    expect(() => deactivate()).not.toThrow();
  });

  it('should invoke scan through the registered command', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'resolveit-vscode-ext-'));
    try {
      __testState.workspaceFolders = [{ name: 'ws', uri: { fsPath: workspaceRoot } } as never];
      activate(mockContext() as never);
      const scan = __testState.registeredCommands.get('resolveit.scan');
      expect(scan).toBeDefined();
      await (scan as () => Promise<void>)();
      expect(
        __testState.outputLines.some((line) => line.includes(`Scanned ${workspaceRoot}`))
      ).toBe(true);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
