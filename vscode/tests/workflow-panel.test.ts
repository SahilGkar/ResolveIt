import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as vscodeMock from './vscode-mock.js';
import { __reset, __testState } from './vscode-mock.js';
import { activate } from '../src/extension.js';
import { ExtensionState } from '../src/state.js';
import { Logger } from '../src/ui/output.js';
import { CoreClient } from '../src/core.js';
import { WorkflowProvider } from '../src/workflow/view.js';
import { renderWorkflowHtml, renderWorkflowBootHtml, renderWorkflowErrorHtml, escapeHtml } from '../src/workflow/render.js';
import { buildWorkflowModel } from '../src/workflow/model.js';
import type { Diagnostic, RepairAction, RepairPlan } from '../../src/index.js';

function mockContext(): { subscriptions: Array<{ dispose(): void }> } {
  return { subscriptions: [] };
}

function provider(): WorkflowProvider {
  const state = new ExtensionState();
  const logger = new Logger({ appendLine: () => undefined, show: () => undefined });
  return new WorkflowProvider(mockContext() as never, state, logger, new CoreClient());
}

function lastPanel(): vscodeMock.WebviewPanelStub {
  const panel = __testState.webviewPanels[__testState.webviewPanels.length - 1];
  expect(panel).toBeDefined();
  return panel!;
}

function lastRenderHtml(): string {
  const panel = lastPanel();
  const render = panel.posted.filter(
    (message): message is { type: string; html: string } =>
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === 'render' &&
      typeof (message as { html?: unknown }).html === 'string'
  );
  expect(render.length).toBeGreaterThan(0);
  return render[render.length - 1]!.html;
}

function extractInlineScript(html: string): string {
  const open = html.indexOf('<script');
  const start = html.indexOf('>', open) + 1;
  const end = html.indexOf('</script>', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

function assertParsesAsJavaScript(source: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'resolveit-webview-'));
  const file = join(dir, 'webview.js');
  try {
    writeFileSync(file, source, 'utf-8');
    expect(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })).not.toThrow();
  } catch (error) {
    throw new Error(
      `emitted webview script is not valid JavaScript: ${
        error instanceof Error && 'stderr' in error ? String((error as { stderr: Buffer }).stderr) : String(error)
      }`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  __reset();
});

describe('workflow panel lifecycle', () => {
  it('creates a WebviewPanel and assigns HTML immediately', () => {
    const workflow = provider();
    workflow.show();

    expect(__testState.webviewPanels).toHaveLength(1);
    const panel = lastPanel();
    expect(panel.viewType).toBe('resolveit.workflow');
    expect(panel.title).toBe('ResolveIt');
    expect(panel.options.enableScripts).toBe(true);
    expect(panel.webview.html).not.toBe('');
    expect(panel.webview.html).toContain('<!DOCTYPE html>');
    expect(panel.disposed).toBe(false);
  });

  it('reuses a single panel and reveals it on repeat invocation', () => {
    const workflow = provider();
    workflow.show();
    workflow.show();

    expect(__testState.webviewPanels).toHaveLength(1);
    expect(lastPanel().revealed).toBe(1);
  });

  it('renders immediately on the ready handshake without any analysis or AI', () => {
    const workflow = provider();
    workflow.show();

    // No AI configured, no workspace, no analysis: the panel must still paint.
    lastPanel().emit({ type: 'ready' });

    const html = lastRenderHtml();
    expect(html).toContain('How should ResolveIt reason?');
    expect(html).toContain('No AI (Deterministic)');
    expect(html).toContain('Local AI (Ollama-compatible)');
    expect(html).toContain('External AI (OpenAI-compatible)');
    expect(html).not.toContain('Loading ResolveIt');
  });

  it('paints a boot screen in the initial document so the tab is never blank', () => {
    const workflow = provider();
    workflow.show();

    const panel = lastPanel();
    expect(panel.webview.html).toContain('Opening the workflow panel');
    expect(panel.webview.html).not.toContain('Loading ResolveIt');
    // The boot screen is in the served document itself, not waiting on a message.
    expect(panel.webview.html.indexOf('wf-boot')).toBeGreaterThan(-1);
  });

  it('emits a ready handshake and installs a render watchdog in the webview', () => {
    const workflow = provider();
    workflow.show();

    const script = extractInlineScript(lastPanel().webview.html);
    expect(script).toContain("post({ type: 'ready' })");
    expect(script).toContain('RENDER_TIMEOUT_MS');
    expect(script).toContain("addEventListener('message'");
    expect(script).toContain("type === 'render'");
    // The failure path must be a real error screen, not an endless placeholder.
    expect(script).toContain('couldn');
    expect(script).toContain('Retry');
  });

  it('emits syntactically valid JavaScript for the webview', () => {
    const workflow = provider();
    workflow.show();

    // Regression guard: a TypeScript-only token such as a `!` non-null assertion
    // previously made the whole script fail to parse, so the message listener was
    // never installed and the panel stayed on its placeholder forever.
    assertParsesAsJavaScript(extractInlineScript(lastPanel().webview.html));
  });

  it('keeps the CSP restrictive and self-contained', () => {
    const workflow = provider();
    workflow.show();

    const html = lastPanel().webview.html;
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-");
    expect(html).toMatch(/<script nonce="[A-Za-z0-9]+">/);
    // No remote origins and no local resource loading are required.
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('asWebviewUri');
  });

  it('stops posting state after the panel is disposed', () => {
    const workflow = provider();
    workflow.show();
    const panel = lastPanel();
    const before = panel.posted.length;

    panel.dispose();
    workflow.refresh();

    expect(panel.posted.length).toBe(before);
  });

  it('opens the panel through the contributed command', async () => {
    activate(mockContext() as never);
    const open = __testState.registeredCommands.get('resolveit.openWorkflow');
    expect(open).toBeDefined();

    await (open as () => Promise<void>)();

    expect(__testState.webviewPanels).toHaveLength(1);
    expect(lastPanel().webview.html).not.toBe('');
  });
});

describe('legacy commands route to the workflow panel', () => {
  const legacyCommands: ReadonlyArray<[string, string]> = [
    ['resolveit.reviewProblems', 'status'],
    ['resolveit.reviewRepairs', 'repair-plan'],
  ];

  it('should route review commands to the workflow instead of deleted views', async () => {
    __testState.workspaceFolders = [{ name: 'ws', uri: { fsPath: 'C:\\ws' } } as never];
    activate(mockContext() as never);

    for (const [command] of legacyCommands) {
      expect(__testState.registeredCommands.has(command)).toBe(true);
      await (__testState.registeredCommands.get(command) as () => Promise<void>)();
      expect(__testState.webviewPanels.length).toBeGreaterThan(0);
    }
  });

  it('should never attempt to focus a view that no longer exists', () => {
    const source = readFileSync(
      new URL('../src/commands.ts', import.meta.url),
      'utf-8'
    );
    expect(source).not.toContain('resolveit.dashboard');
    expect(source).not.toContain('resolveit.diagnostics');
    expect(source).not.toContain('revealView');
  });

  it('should expose an Open Workflow entry point for every stage command', async () => {
    __testState.workspaceFolders = [{ name: 'ws', uri: { fsPath: 'C:\\ws' } } as never];
    activate(mockContext() as never);

    // Generate Repair Plan and Apply Approved Repairs must still work and must
    // surface the workflow rather than a removed sidebar view.
    for (const command of ['resolveit.generateRepairPlan', 'resolveit.applyApprovedRepairs']) {
      expect(__testState.registeredCommands.has(command)).toBe(true);
    }
    await (__testState.registeredCommands.get('resolveit.generateRepairPlan') as () => Promise<void>)();
    expect(__testState.webviewPanels.length).toBeGreaterThan(0);
  });
});

describe('workflow render states', () => {
  it('reports an initialization failure with a retry action', () => {
    const html = renderWorkflowErrorHtml('host exploded');
    expect(html).toContain("ResolveIt couldn't start.");
    expect(html).toContain('host exploded');
    expect(html).toContain('data-command="workflow.retryInit"');
    expect(html).not.toContain('Loading ResolveIt');
  });

  it('never leaks untrusted text through the error screen', () => {
    const html = renderWorkflowErrorHtml('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('renders a dependency status without internal diagnostic counters', () => {
    const state = new ExtensionState();
    state.bindWorkspace('/ws');
    state.markScanned();
    state.setRequirements([
      {
        projectId: 'p',
        sourceFiles: ['package.json'],
        requirements: [
          { id: 'r1', ecosystem: 'node', type: 'package-dependency', name: 'express', versionConstraint: '^5.1.0', sourceFile: 'package.json' },
        ],
        parseErrors: [],
      } as never,
    ]);
    state.setDiagnostics([
      { id: 'd1', severity: 'error', category: 'dependency', code: 'DEPENDENCY_PACKAGE_MISSING', title: 'Dependency: express', message: 'not currently installed', evidence: [], source: 'dependency-resolver', timestamp: new Date(), metadata: {}, requirement: { name: 'express', versionConstraint: '^5.1.0' } } as Diagnostic,
      { id: 'd2', severity: 'info', category: 'dependency', code: 'X', title: 't', message: 'm', evidence: [], source: 'dependency-resolver', timestamp: new Date(), metadata: {} } as Diagnostic,
    ]);

    const model = buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: '/ws' });
    const html = renderWorkflowHtml(model);

    expect(html).toContain('Project Status');
    expect(html).toContain('Requirements: <strong>1</strong>');
    expect(html).toContain('Installed dependencies: <strong>0</strong>');
    expect(html).toContain('Dependencies to install: <strong>1</strong>');
    expect(html).toContain('express ^5.1.0');
    expect(html).not.toContain('Informational findings');
    expect(html).not.toContain('Blocking issues');
    expect(html).not.toContain('Issues: <strong>');
    expect(html).toContain('data-command="workflow.generatePlan"');
  });

  it('offers bulk and individual approval with an accurate count', () => {
    const state = new ExtensionState();
    state.bindWorkspace('/ws');
    state.markScanned();
    const action = (id: string): RepairAction => ({
      id,
      type: 'install-dependency',
      permissionLevel: 'project-modification',
      description: `Install ${id}`,
      target: {},
      parameters: {},
      riskLevel: 'project-modification',
      prerequisites: [],
    });
    const plan: RepairPlan = {
      id: 'plan-1',
      name: 'p',
      description: 'd',
      actions: [action('a'), action('b'), action('c')],
      requiresApproval: true,
    };
    state.setRepairPlan(plan);
    state.setApproval('a', true);
    state.setApproval('b', true);

    const model = buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: '/ws' });
    const html = renderWorkflowHtml(model);

    expect(html).toContain('2 / 3 approved');
    expect(html).toContain('data-command="workflow.approveAll"');
    expect(html).toContain('data-command="workflow.denyAll"');
    expect(html).toContain('data-command="workflow.apply"');
    expect(html).toContain('data-action-id="c"');
  });

  it('never shows approval controls next to an execution failure', () => {
    const state = new ExtensionState();
    state.bindWorkspace('/ws');
    state.markScanned();
    const action: RepairAction = {
      id: 'a',
      type: 'install-dependency',
      permissionLevel: 'project-modification',
      description: 'Install a',
      target: {},
      parameters: {},
      riskLevel: 'project-modification',
      prerequisites: [],
    };
    state.setRepairPlan({ id: 'p', name: 'p', description: 'd', actions: [action], requiresApproval: true });
    state.setApproval('a', true);
    state.setExecution({
      results: [{ action, result: { success: false, error: 'Unsupported ecosystem: undefined' } }],
      success: false,
      timestamp: new Date(),
    });

    const model = buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: '/ws' });
    const html = renderWorkflowHtml(model);

    expect(html).toContain('Unsupported ecosystem: undefined');
    expect(html).not.toContain('Awaiting approval');
    // A failed action offers no approval control at all: no checkbox and no
    // toggle command, not even a disabled one.
    expect(html).not.toContain('workflow.toggleApproval');
    expect(html).not.toContain('wf-action-checkbox');
    expect(html).toContain('Failed');
  });

  it('returns to the repair plan when verification fails', () => {
    const state = new ExtensionState();
    state.bindWorkspace('/ws');
    state.markScanned();
    state.setLastVerification({ resolved: ['a'], remaining: ['b'], timestamp: new Date() });

    const model = buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: '/ws' });
    expect(model.currentStep).toBe('failed');

    const html = renderWorkflowHtml(model);
    expect(html).toContain('Return to Repair Plan');
    expect(html).toContain('data-command="workflow.returnToPlan"');
  });

  it('never manufactures success from a baseline re-check', () => {
    const state = new ExtensionState();
    state.bindWorkspace('/ws');
    state.markScanned();
    state.setLastVerification({ resolved: ['a'], remaining: [], timestamp: new Date() });

    const model = buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: '/ws' });
    // No execution happened, so this is a baseline re-check, not a completed
    // workflow: it must land on Verify, never jump to Done.
    expect(model.currentStep).toBe('verify');
    const html = renderWorkflowHtml(model);
    expect(html).not.toContain('Final check passed');
    expect(html).toContain('Verify Changes');
  });

  it('escapes untrusted project paths and error text', () => {
    expect(escapeHtml('<script>x</script>')).toBe('&lt;script&gt;x&lt;/script&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');

    const state = new ExtensionState();
    state.bindWorkspace('/ws');
    state.markScanned();
    state.setLastError('<img src=x onerror=1>');

    const model = buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: '<b>evil</b>',
      workspaceRoot: '/ws',
    });
    const html = renderWorkflowHtml(model);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>evil</b>');
  });

  it('keeps the boot screen free of untrusted interpolation', () => {
    expect(renderWorkflowBootHtml()).toContain('ResolveIt');
    expect(renderWorkflowBootHtml()).not.toContain('undefined');
  });
});
