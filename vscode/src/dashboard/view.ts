import * as vscode from 'vscode';
import { buildDashboardModel } from './model.js';
import { snapshotFromState } from './snapshot.js';
import { dashboardStyles, renderDashboardBody } from './render.js';
import { toRepairCard } from './cards.js';
import { validateDashboardMessage } from './messages.js';
import type { ExtensionState } from '../state.js';
import type { Logger } from '../ui/output.js';

export interface DashboardProviderOptions {
  readonly isMultiRoot: () => boolean;
  readonly executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown>;
}

export class DashboardProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'resolveit.dashboard';

  private view?: vscode.WebviewView;

  constructor(
    private readonly state: ExtensionState,
    private readonly logger: Logger,
    private readonly options: DashboardProviderOptions
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = this.webviewHtml();
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
    this.postState();
  }

  refresh(): void {
    if (!this.view) {
      return;
    }
    this.postState();
  }

  private async handleMessage(message: unknown): Promise<void> {
    const validated = validateDashboardMessage(message);
    if (!validated) {
      this.logger.warn('Dashboard sent an unrecognized message; ignoring it.');
      return;
    }
    if (validated.command === 'resolveit.approveAction' || validated.command === 'resolveit.skipAction') {
      const plan = this.state.getRepairPlan();
      const known = plan?.actions.some((action) => action.id === validated.actionId) ?? false;
      if (!known) {
        this.logger.warn(`Dashboard requested approval for an unknown action (${validated.actionId ?? 'missing'}); ignoring it.`);
        return;
      }
    }
    try {
      if (validated.actionId !== undefined) {
        await this.options.executeCommand(validated.command, validated.actionId);
      } else {
        await this.options.executeCommand(validated.command);
      }
    } catch (error) {
      this.logger.error(`Dashboard command ${validated.command} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.postState();
  }

  private postState(): void {
    if (!this.view) {
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const snapshot = snapshotFromState(this.state, {
      hasWorkspace: folders.length > 0,
      workspaceName: folders[0]?.name,
    });
    const model = buildDashboardModel(snapshot);
    const plan = this.state.getRepairPlan();
    const execution = this.state.getExecution();
    const verification = this.state.getLastVerification();
    const ai = this.state.getAIStatus();
    const verifiedKeys = new Set(verification?.resolved ?? []);
    const cards = (plan?.actions ?? []).map((action) => {
      const approval = this.state.getApproval(action.id);
      const entry = execution?.results.find((candidate) => candidate.action.id === action.id);
      return toRepairCard(action, approval, entry ? { result: entry.result, verified: verifiedKeys.size > 0, executing: false } : undefined);
    });
    const body = renderDashboardBody({
      model,
      workspaceName: folders[0]?.name ?? 'No folder open',
      multiRoot: this.options.isMultiRoot(),
      ai: ai ? { provider: ai.provider, model: ai.model, available: ai.available } : undefined,
      aiSummary: this.state.getAISummary(),
      cards,
      verification: verification ? { resolved: verification.resolved.length, remaining: verification.remaining.length } : undefined,
      execution: execution
        ? {
            succeeded: execution.results.filter((entry) => entry.result.success).length,
            failed: execution.results.filter((entry) => !entry.result.success).length,
          }
        : undefined,
      environmentReady: this.state.getEnvironment() ? true : undefined,
    });
    void this.view.webview.postMessage({ type: 'render', html: body });
  }

  private webviewHtml(): string {
    const nonce = Buffer.from(String(Date.now())).toString('base64').replace(/[^A-Za-z0-9]/g, 'n');
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="UTF-8">',
      `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `<style>${dashboardStyles()}</style>`,
      '</head>',
      '<body>',
      '<div id="root" aria-live="polite"><p class="desc">Loading ResolveIt dashboard…</p></div>',
      `<script nonce="${nonce}">`,
      '(function(){var api=acquireVsCodeApi();var root=document.getElementById("root");',
      'document.addEventListener("click",function(e){var t=e.target;if(!(t instanceof HTMLElement))return;',
      'var el=t.closest("[data-command]");if(!el)return;var cmd=el.getAttribute("data-command");if(!cmd)return;',
      'var msg={type:"command",command:cmd};var id=el.getAttribute("data-action-id");if(id)msg.actionId=id;',
      'api.postMessage(msg);});',
      'window.addEventListener("message",function(e){var m=e.data;if(m&&m.type==="render"&&typeof m.html==="string"){root.innerHTML=m.html;}});',
      '})();',
      '</script>',
      '</body>',
      '</html>',
    ].join('\n');
  }
}
