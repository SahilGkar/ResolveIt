import { describe, it, expect, beforeEach } from 'vitest';
import Module from 'module';
import * as vscodeMock from './vscode-mock.js';
import { __reset, __testState } from './vscode-mock.js';

const originalLoad = Module._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') {
    return vscodeMock;
  }
  return (originalLoad as (...args: unknown[]) => unknown).call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bundled = require('../dist/extension.js') as {
  activate(context: unknown): void;
  deactivate(): void;
  COMMAND_IDS: ReadonlyArray<string>;
};

beforeEach(() => {
  __reset();
});

describe('bundled extension artifact', () => {
  it('should activate from the built bundle', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    bundled.activate(context);
    for (const id of bundled.COMMAND_IDS) {
      expect(__testState.registeredCommands.has(id)).toBe(true);
    }
    expect(__testState.registeredViews).toEqual([
      'resolveit.dashboard',
      'resolveit.project',
      'resolveit.diagnostics',
      'resolveit.environment',
      'resolveit.requirements',
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(__testState.outputLines.some((line) => line.includes('activated'))).toBe(true);
    expect(() => bundled.deactivate()).not.toThrow();
  });
});
