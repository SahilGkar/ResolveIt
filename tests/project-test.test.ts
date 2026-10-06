import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectProjectTestCommand,
  runProjectTest,
  NO_PROJECT_TEST_COMMAND_MESSAGE,
} from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop() as string;
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'resolveit-project-test-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content, 'utf-8');
  }
  return root;
}

describe('detectProjectTestCommand', () => {
  it('should detect an npm test script', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }),
    });
    const command = await detectProjectTestCommand(root);
    expect(command).toMatchObject({ runner: 'npm', label: 'npm test', script: 'test', sourceFile: 'package.json' });
    expect(command?.args).toEqual(['test']);
  });

  it('should fall back to start, then build', async () => {
    const withStart = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { start: 'node index.js' } }),
    });
    expect((await detectProjectTestCommand(withStart))?.label).toBe('npm run start');

    const withBuild = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { build: 'tsc' } }),
    });
    expect((await detectProjectTestCommand(withBuild))?.label).toBe('npm run build');
  });

  it('should refuse scripts outside the allowlist', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { deploy: 'rm -rf /' } }),
    });
    expect(await detectProjectTestCommand(root)).toBeUndefined();
  });

  it('should report no command for a project without a manifest', async () => {
    const root = await fixture({});
    expect(await detectProjectTestCommand(root)).toBeUndefined();
  });

  it('should ignore empty script bodies', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { test: '   ' } }),
    });
    expect(await detectProjectTestCommand(root)).toBeUndefined();
  });
});

describe('runProjectTest', () => {
  it('should actually execute the project npm test command', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(0)"' } }),
    });
    const result = await runProjectTest(root, 30000);
    expect(result.attempted).toBe(true);
    expect(result.command?.label).toBe('npm test');
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  }, 60000);

  it('should report a non-zero exit as a failed test', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(3)"' } }),
    });
    const result = await runProjectTest(root, 30000);
    expect(result.attempted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain('exit code 3');
  }, 60000);

  it('should say so plainly when no safe test command exists', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    });
    const result = await runProjectTest(root, 30000);
    expect(result.attempted).toBe(false);
    expect(result.success).toBe(false);
    expect(result.message).toBe(NO_PROJECT_TEST_COMMAND_MESSAGE);
  });
});
