import * as vscode from 'vscode';
import type { ExtensionState } from '../state.js';
import type { Logger } from '../ui/output.js';
import type { CoreClient } from '../core.js';
import type { AIConfig } from '../../../src/index.js';
import { workflowStyles, renderWorkflowHtml } from './render.js';
import { buildWorkflowModel } from './model.js';
import { createWorkflowCommandHandlers, type WorkflowCommandContext } from './commands.js';

export class WorkflowProvider {
  private panel?: vscode.WebviewPanel;
  private state: ExtensionState;
  private logger: Logger;
  private core: CoreClient;
  private commandHandlers: ReturnType<typeof createWorkflowCommandHandlers>;
  private context: vscode.ExtensionContext;

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

  private getAIConfig(): AIConfig {
    const settings = vscode.workspace.getConfiguration('resolveit');
    return {
      provider: settings.get('ai.provider', 'none') as 'none' | 'local' | 'external',
      model: settings.get('ai.model', ''),
      baseUrl: settings.get('ai.baseUrl', ''),
      timeoutMs: settings.get('ai.timeout', 30000),
    };
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
      '<div id="root" aria-live="polite"><p class="wf-loading">Loading ResolveIt…</p></div>',
      `<script nonce="${nonce}">`,
      '(function(){var api=acquireVsCodeApi();var root=document.getElementById("root");',
      'function paint(){var c=root.querySelector("[data-wf-toggle]");var x=root.querySelector(".wf-expanded");',
      'if(!c||!x)return;var ex=!!api.getState()?.expanded;c.hidden=ex;x.hidden=!ex;',
      'c.setAttribute("aria-expanded",ex?"true":"false");}',
      'function save(){try{api.setState({expanded:!root.querySelector("[data-wf-toggle]")?.hidden});}catch(e){}}',
      'document.addEventListener("click",function(e){var t=e.target;if(!(t instanceof HTMLElement))return;',
      'var tg=t.closest("[data-wf-toggle]");if(tg){var ex=!tg.hidden;tg.hidden=ex;root.querySelector(".wf-expanded")!.hidden=!ex;save();paint();return;}',
      'var el=t.closest("[data-command]");if(!el||el.disabled)return;var cmd=el.getAttribute("data-command");if(!cmd)return;',
      'var msg={type:"command",command:cmd};var id=el.getAttribute("data-action-id");if(id)msg.actionId=id;',
      'var step=el.getAttribute("data-step");if(step)msg.step=step;api.postMessage(msg);});',
      'window.addEventListener("message",function(e){var m=e.data;if(m&&m.type==="render"&&typeof m.html==="string"){root.innerHTML=m.html;paint();}});',
      '})();',
      '</script>',
      '</body>',
      '</html>',
    ].join('\n');
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const msg = message as { type?: string; command?: string; actionId?: string; step?: string; data?: unknown };
    if (msg.type !== 'command' || !msg.command) return;

    const handler = this.commandHandlers[msg.command];
    if (handler) {
      try {
        await handler(msg.actionId, msg.step, msg.data);
      } catch (error) {
        this.logger.error(`Workflow command ${msg.command} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.postState();
  }

  private postState(): void {
    const panel = this.panel;
    if (!panel) return;
    const root = this.getWorkspaceRoot();
    const folders = vscode.workspace.workspaceFolders;
    const workspaceName = folders && folders.length > 0 && folders[0] ? folders[0].name : 'No folder open';
    const model = buildWorkflowModel(this.state, { hasWorkspace: !!root, workspaceName, workspaceRoot: root });
    const html = renderWorkflowHtml(model);
    panel.webview.postMessage({ type: 'render', html });
  }

  refresh(): void {
    this.postState();
  }
}

function createWorkflowCommandContext(ctx: WorkflowCommandContext): ReturnType<typeof createWorkflowCommandHandlers> {
  return createWorkflowCommandHandlers(ctx);
}