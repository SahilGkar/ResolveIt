import * as vscode from 'vscode';
import { resolveAIConfig } from '../../../src/index.js';
import type { ExtensionState } from '../state.js';
import type { Logger } from '../ui/output.js';
import type { CoreClient } from '../core.js';
import type { AIConfig } from '../../../src/index.js';
import { configToAIConfigOverrides } from '../mappers.js';
import { workflowStyles, renderWorkflowHtml, renderWorkflowBootHtml, renderWorkflowErrorHtml } from './render.js';
import { validateWorkflowMessage, isWorkflowNavigation } from './messages.js';
import { buildWorkflowModel, adjacentStep, type WorkflowStep } from './model.js';
import { createWorkflowCommandHandlers, type WorkflowCommandContext } from './commands.js';

/** Stages that require workflow results; meaningless as a cursor with fresh state. */
const POST_ANALYSIS_STEPS: ReadonlySet<WorkflowStep> = new Set([
  'repair-plan',
  'apply',
  'verify',
  'success',
  'failed',
]);

/**
 * Webview-side runtime.
 *
 * Must be plain, syntactically valid JavaScript. It is emitted verbatim into the
 * panel HTML, so TypeScript-only syntax (for example a `!` non-null assertion)
 * must never appear here: the whole block would fail to parse, the message
 * listener would never install, and the panel would stay on its placeholder.
 */
const WORKFLOW_WEBVIEW_SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  var root = document.getElementById('root');
  var RENDER_TIMEOUT_MS = 8000;
  var rendered = false;
  var timer = 0;

  function escapeText(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function post(message) {
    try {
      vscode.postMessage(message);
    } catch (error) {
      reportError(error);
    }
  }

  function reportError(error) {
    var reason = error && error.message ? error.message : String(error);
    try {
      vscode.postMessage({ type: 'webviewError', data: reason });
    } catch (ignored) {
      /* the host is already gone; nothing further to report */
    }
  }

  function showFailure(message) {
    rendered = true;
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    root.innerHTML =
      '<div class="wf-boot wf-boot-failed">' +
      '<h1 class="wf-boot-title">ResolveIt couldn\\'t start.</h1>' +
      '<p class="wf-boot-text">' +
      escapeText(message) +
      '</p>' +
      '<button class="wf-btn primary" id="wf-retry">Retry</button>' +
      '</div>';
    var retry = document.getElementById('wf-retry');
    if (retry) {
      retry.addEventListener('click', function () {
        rendered = false;
        armWatchdog();
        post({ type: 'ready' });
      });
    }
  }

  function armWatchdog() {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(function () {
      if (!rendered) {
        showFailure(
          'The ResolveIt panel did not receive its first update. The extension host may still be starting.'
        );
      }
    }, RENDER_TIMEOUT_MS);
  }

  function render(html) {
    rendered = true;
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    root.innerHTML = html;
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    var trigger = target.closest('[data-command]');
    if (!trigger || trigger.disabled) {
      return;
    }
    var command = trigger.getAttribute('data-command');
    if (!command) {
      return;
    }
    var message = { type: 'command', command: command };
    var actionId = trigger.getAttribute('data-action-id');
    if (actionId) {
      message.actionId = actionId;
    }
    var step = trigger.getAttribute('data-step');
    if (step) {
      message.step = step;
    }
    post(message);
  });

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (message && message.type === 'render' && typeof message.html === 'string') {
      render(message.html);
    }
  });

  window.addEventListener('error', function (event) {
    reportError(event && event.message ? event.message : 'webview script error');
  });

  // Tell the host we are listening. The host replies with the first render, which is
  // why opening the panel no longer depends on message-delivery timing.
  armWatchdog();
  post({ type: 'ready' });
})();
`.trim();

export class WorkflowProvider {
  private panel?: vscode.WebviewPanel;
  private state: ExtensionState;
  private logger: Logger;
  private core: CoreClient;
  private commandHandlers: ReturnType<typeof createWorkflowCommandHandlers>;
  private context: vscode.ExtensionContext;
  /**
   * Stage the user is currently viewing. The panel always opens on AI Mode, which
   * is the first stage of the workflow, and only moves on when the user asks or
   * when real Core results move it.
   */
  private cursor: WorkflowStep = 'ai-mode';

  constructor(
    context: vscode.ExtensionContext,
    state: ExtensionState,
    logger: Logger,
    core: CoreClient
  ) {
    this.context = context;
    this.state = state;
    this.logger = logger;
    this.core = core;

    this.commandHandlers = createWorkflowCommandContext({
      state,
      logger,
      core,
      showMessage: (message: string) => vscode.window.showInformationMessage(message),
      showWarning: (message: string) => vscode.window.showWarningMessage(message),
      showError: (message: string) => vscode.window.showErrorMessage(message),
      showProgress: <T>(title: string, task: (report: (msg: string) => void) => Promise<T>) =>
        Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, async (progress) => task((msg) => progress.report({ message: msg })))),
      showCancellableProgress: <T>(title: string, task: (report: (msg: string) => void, token: { isCancellationRequested: boolean; onCancellationRequested: (cb: () => void) => void }) => Promise<T>) =>
        Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => task((msg) => progress.report({ message: msg }), token))),
      getAIConfig: () => this.getAIConfig(),
      getMaxIterations: () => this.getMaxIterations(),
      getWorkspaceRoot: () => this.getWorkspaceRoot(),
      openFile: async (path: string) => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
        await vscode.window.showTextDocument(doc);
      },
      postMessage: (message: unknown) => this.panel?.webview.postMessage(message),
    });
  }

  /**
   * Read AI configuration through the Core resolver so settings, environment
   * variables and safe defaults all behave exactly as they do for every other
   * entry point. API keys are never placed in webview state.
   */
  private getAIConfig(): AIConfig {
    const settings = vscode.workspace.getConfiguration('resolveit');
    return resolveAIConfig(
      configToAIConfigOverrides({
        provider: settings.get('ai.provider'),
        model: settings.get('ai.model'),
        baseUrl: settings.get('ai.baseUrl'),
        timeout: settings.get('ai.timeout'),
      })
    );
  }

  private getMaxIterations(): number {
    return vscode.workspace.getConfiguration('resolveit').get('maxIterations', 3);
  }

  private getWorkspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return '';
    const folder = folders[0];
    return folder ? folder.uri.fsPath : '';
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'resolveit.workflow',
      'ResolveIt',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    this.panel = panel;
    panel.webview.html = this.getWebviewHtml();
    panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message));
    panel.onDidDispose(() => { this.panel = undefined; }, null, this.context.subscriptions);

    this.postState();
  }

  private getWebviewHtml(): string {
    const nonce = Buffer.from(String(Date.now())).toString('base64').replace(/[^A-Za-z0-9]/g, 'n');
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="UTF-8">',
      `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `<style>${workflowStyles()}</style>`,
      '</head>',
      '<body>',
      // Painted synchronously by the document itself, so the tab is never blank and
      // never shows a "Loading ResolveIt..." placeholder that depends on a handshake.
      `<div id="root" aria-live="polite">${renderWorkflowBootHtml()}</div>`,
      `<script nonce="${nonce}">${WORKFLOW_WEBVIEW_SCRIPT}</script>`,
      '</body>',
      '</html>',
    ].join('\n');
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const msg = message as { type?: string; data?: unknown };

    // The webview announces that its message listener is installed. This handshake is
    // what makes the first render reliable: posting HTML before the listener exists
    // silently drops the message and used to leave the panel stuck forever.
    if (msg.type === 'ready') {
      this.postState();
      return;
    }

    if (msg.type === 'webviewError') {
      this.logger.error(`ResolveIt workflow webview error: ${typeof msg.data === 'string' ? msg.data : 'unknown'}`);
      return;
    }

    const validated = validateWorkflowMessage(message);
    if (!validated) {
      this.logger.warn('ResolveIt workflow received an unrecognized message; ignoring it.');
      return;
    }

    // Panel navigation is view state, so it is handled here rather than in the
    // shared command handlers.
    if (isWorkflowNavigation(validated.command)) {
      this.navigate(validated.command === 'workflow.goBack' ? 'back' : 'forward');
      return;
    }

    const handler = this.commandHandlers[validated.command];
    if (handler) {
      try {
        await handler(validated.actionId, validated.step);
      } catch (error) {
        this.logger.error(
          `Workflow command ${validated.command} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    this.postState();
  }

  private postState(): void {
    const panel = this.panel;
    if (!panel) return;
    try {
      // After an explicit reset there is nothing to derive from, so a stale
      // post-analysis cursor is dropped and the panel genuinely returns to
      // AI Mode instead of landing on an arbitrary derived stage.
      if (this.isWorkflowFresh() && POST_ANALYSIS_STEPS.has(this.cursor)) {
        this.cursor = 'ai-mode';
      }
      const root = this.getWorkspaceRoot();
      const folders = vscode.workspace.workspaceFolders;
      const first = folders && folders.length > 0 ? folders[0] : undefined;
      const workspaceName = first ? first.name : 'No folder open';
      const model = buildWorkflowModel(this.state, {
        hasWorkspace: root.length > 0,
        workspaceName,
        workspaceRoot: root,
        requestedStep: this.cursor,
      });
      // Keep the cursor aligned with wherever real results landed the workflow.
      this.cursor = model.currentStep;
      void panel.webview.postMessage({ type: 'render', html: renderWorkflowHtml(model) });
    } catch (error) {
      // Never leave the panel on its previous screen when the host side fails.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`ResolveIt workflow render failed: ${reason}`);
      void panel.webview.postMessage({
        type: 'render',
        html: renderWorkflowErrorHtml(`ResolveIt could not render the workflow. ${reason}`),
      });
    }
  }

  /** Move the panel to an explicit stage requested by the user. */
  navigate(direction: 'forward' | 'back'): void {
    const model = buildWorkflowModel(this.state, {
      hasWorkspace: this.getWorkspaceRoot().length > 0,
      workspaceName: 'ResolveIt',
      workspaceRoot: this.getWorkspaceRoot(),
      requestedStep: this.cursor,
    });
    const next = adjacentStep(model.currentStep, direction);
    if (next) {
      this.cursor = next;
      this.logger.info(`Workflow stage: ${model.currentStep} -> ${next}`);
      this.postState();
    }
  }

  /** Jump to a specific stage (used when the user runs a stage's action). */
  goToStep(step: WorkflowStep): void {
    this.cursor = step;
    this.postState();
  }

  /**
   * True when no workflow progress exists at all (fresh start or after Start
   * Over). A stale post-analysis cursor is then dropped so the panel genuinely
   * returns to AI Mode; pre-analysis cursor positions are left alone so manual
   * Back/Next keeps working before analysis runs.
   */
  private isWorkflowFresh(): boolean {
    return (
      !this.state.getHasScanned() &&
      this.state.getRepairPlan() === undefined &&
      this.state.getExecution() === undefined &&
      this.state.getLastVerification() === undefined &&
      this.state.getLastError() === undefined &&
      this.state.getActiveOperation() === undefined &&
      this.state.getProjectTest() === undefined &&
      this.state.getProjectSmoke() === undefined
    );
  }

  refresh(): void {
    this.postState();
  }
}

function createWorkflowCommandContext(ctx: WorkflowCommandContext): ReturnType<typeof createWorkflowCommandHandlers> {
  return createWorkflowCommandHandlers(ctx);
}