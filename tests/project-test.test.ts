import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createConnection } from 'net';
import {
  detectProjectTestCommand,
  runProjectTest,
  NO_PROJECT_TEST_COMMAND_MESSAGE,
  detectProjectSmokeCommand,
  runProjectSmoke,
  NO_PROJECT_SMOKE_COMMAND_MESSAGE,
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

function portClosed(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      socket.end();
      resolvePromise(false);
    });
    socket.on('error', () => resolvePromise(true));
    setTimeout(() => {
      socket.destroy();
      resolvePromise(true);
    }, 2000);
  });
}

describe('detectProjectTestCommand', () => {
  it('should detect an npm test script', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }),
    });
    const command = await detectProjectTestCommand(root);
    expect(command).toMatchObject({ runner: 'npm', label: 'npm test', source: 'package.json#scripts.test' });
    expect(command?.args).toEqual(['test']);
  });

  it('should never treat start, build, or dev scripts as tests', async () => {
    const withStart = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { start: 'node index.js' } }),
    });
    expect(await detectProjectTestCommand(withStart)).toBeUndefined();

    const withBuild = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { build: 'tsc' } }),
    });
    expect(await detectProjectTestCommand(withBuild)).toBeUndefined();

    const withDev = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { dev: 'vite --port 5173' } }),
    });
    expect(await detectProjectTestCommand(withDev)).toBeUndefined();
  });

  it('should detect pytest, cargo, go, dotnet, maven, and gradle tests', async () => {
    const python = await fixture({
      'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    });
    expect(await detectProjectTestCommand(python)).toMatchObject({ runner: 'pytest', label: 'pytest -q' });

    const rust = await fixture({ 'Cargo.toml': '[package]\nname = "demo"\n' });
    expect(await detectProjectTestCommand(rust)).toMatchObject({ runner: 'cargo', label: 'cargo test' });

    const go = await fixture({ 'go.mod': 'module demo\n\ngo 1.21\n' });
    expect(await detectProjectTestCommand(go)).toMatchObject({ runner: 'go', label: 'go test ./...' });

    const dotnet = await fixture({ 'demo.csproj': '<Project />\n' });
    expect(await detectProjectTestCommand(dotnet)).toMatchObject({ runner: 'dotnet', label: 'dotnet test' });

    const maven = await fixture({ 'pom.xml': '<project />\n' });
    expect(await detectProjectTestCommand(maven)).toMatchObject({ runner: 'mvn', label: 'mvn test' });

    const gradle = await fixture({ 'build.gradle': 'plugins {}\n' });
    expect(await detectProjectTestCommand(gradle)).toMatchObject({ runner: 'gradle', label: 'gradle test' });
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

  it('should report cancellation honestly instead of as a pass or failure', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node -e "setTimeout(() => {}, 60000)"' } }),
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2000);
    const result = await runProjectTest(root, 60000, controller.signal);
    expect(result.attempted).toBe(true);
    expect(result.cancelled).toBe(true);
    expect(result.success).toBe(false);
    expect(result.message).toContain('cancelled');
  }, 60000);
});

describe('detectProjectSmokeCommand', () => {
  it('should prefer dev over start', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { dev: 'vite --port 5173', start: 'node server.js' } }),
    });
    const command = await detectProjectSmokeCommand(root);
    expect(command).toMatchObject({ runner: 'npm', label: 'npm run dev', source: 'package.json#scripts.dev' });
    expect(command?.args).toEqual(['run', 'dev']);
  });

  it('should fall back to start when there is no dev script', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { start: 'node server.js' } }),
    });
    expect(await detectProjectSmokeCommand(root)).toMatchObject({ label: 'npm run start' });
  });

  it('should report no command when neither dev nor start exists', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }),
    });
    expect(await detectProjectSmokeCommand(root)).toBeUndefined();
  });
});

describe('runProjectSmoke', () => {
  const SERVER = `require('http').createServer((req, res) => { res.writeHead(200); res.end('ok'); }).listen(48761, () => console.log('up'));setInterval(() => {}, 1000000);`;

  it('should detect readiness on an arbitrary port and terminate the tree', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { dev: 'node server.js' } }),
      'server.js': SERVER,
    });
    const result = await runProjectSmoke(root, { readinessTimeoutMs: 30000 });
    expect(result.attempted).toBe(true);
    expect(result.command?.label).toBe('npm run dev');
    expect(result.started).toBe(true);
    expect(result.listening).toBe(true);
    expect(result.responded).toBe(true);
    expect(result.success).toBe(true);
    expect(result.port).toBe(48761);
    expect(result.message).toContain('responded successfully');
    expect(await portClosed(48761)).toBe(true);
  }, 120000);

  it('should fail honestly when nothing becomes reachable', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { start: 'node -e "setTimeout(() => {}, 60000)"' } }),
    });
    const result = await runProjectSmoke(root, { readinessTimeoutMs: 8000 });
    expect(result.attempted).toBe(true);
    expect(result.started).toBe(true);
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.message).toContain('did not become reachable');
  }, 60000);

  it('should report an immediately-exiting server as not a running server', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { start: 'node -e "process.exit(1)"' } }),
    });
    const result = await runProjectSmoke(root, { readinessTimeoutMs: 15000 });
    expect(result.attempted).toBe(true);
    expect(result.started).toBe(false);
    expect(result.success).toBe(false);
    expect(result.message).toContain('instead of staying up');
  }, 60000);

  it('should say so plainly when no run command exists', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }),
    });
    const result = await runProjectSmoke(root);
    expect(result.attempted).toBe(false);
    expect(result.success).toBe(false);
    expect(result.message).toBe(NO_PROJECT_SMOKE_COMMAND_MESSAGE);
  });

  it('should cancel an in-flight smoke check and kill the server', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { dev: 'node server.js' } }),
      'server.js': SERVER.replace('48761', '48762'),
    });
    const controller = new AbortController();
    // Abort while the launch is still settling (inside the early-exit window),
    // so cancellation — not accidental readiness — decides the outcome.
    setTimeout(() => controller.abort(), 1000);
    const result = await runProjectSmoke(root, { readinessTimeoutMs: 60000, signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(result.success).toBe(false);
    expect(await portClosed(48762)).toBe(true);
  }, 120000);
});
