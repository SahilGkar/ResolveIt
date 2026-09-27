import * as vscode from 'vscode';
import { snapshotFromState } from '../dashboard/snapshot.js';
import { toRepairCard } from '../dashboard/cards.js';
import { validateDashboardMessage } from '../dashboard/messages.js';
import { buildHubModel } from './model.js';
import { hubStyles, renderHubBody } from './render.js';
import type { ExtensionState } from '../state.js';
import type { Logger } from '../ui/output.js';

export interface HubProviderOptions {
  readonly isMultiRoot: () => boolean;
  readonly executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown>;
}

export class HubProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'resolveit.dashboard';

  private view?: vscode.WebviewView;

  constructor(
    private readonly state: ExtensionState,
    private readonly logger: Logger,
    private readonly options: HubProviderOptions
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
      this.logger.warn('Action Hub sent an unrecognized message; ignoring it.');
      return;
    }
    if (validated.command === 'resolveit.approveAction' || validated.command === 'resolveit.skipAction') {
      const plan = this.state.getRepairPlan();
      const known = plan?.actions.some((action) => action.id === validated.actionId) ?? false;
      if (!known) {
        this.logger.warn(`Action Hub requested approval for an unknown action (${validated.actionId ?? 'missing'}); ignoring it.`);
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
      this.logger.error(`Action Hub command ${validated.command} failed: ${error instanceof Error ? error.message : String(error)}`);
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
    const model = buildHubModel(snapshot);
    const plan = this.state.getRepairPlan();
    const execution = this.state.getExecution();
    const verification = this.state.getLastVerification();
    const verifiedKeys = new Set(verification?.resolved ?? []);
    const cards = (plan?.actions ?? []).map((action) => {
      const approval = this.state.getApproval(action.id);
      const entry = execution?.results.find((candidate) => candidate.action.id === action.id);
      return toRepairCard(action, approval, entry ? { result: entry.result, verified: verifiedKeys.size > 0, executing: false } : undefined);
    });
    const applyNode = model.nodes.find((node) => node.id === 'apply');
    const body = renderHubBody({
      model,
      workspaceName: folders[0]?.name ?? 'No folder open',
      multiRoot: this.options.isMultiRoot(),
      aiSummary: this.state.getAISummary(),
      cards,
      canApply: (applyNode?.enabled ?? false) && (applyNode?.command === 'resolveit.applyApprovedRepairs'),
      applySub: applyNode?.enabled === true ? (applyNode.sub ?? '') : (applyNode?.disabledReason ?? 'Review each change first.'),
      verification: verification ? { resolved: verification.resolved.length, remaining: verification.remaining.length } : undefined,
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
      `<style>${hubStyles()}</style>`,
      '</head>',
      '<body>',
      '<div id="root" aria-live="polite"><p class="hub-sub">Loading ResolveIt…</p></div>',
      `<script nonce="${nonce}">`,
      '(function(){var api=acquireVsCodeApi();var root=document.getElementById("root");',
      'var ui=api.getState()||{expanded:false,screen:"hub"};',
      'function paint(){var c=root.querySelector("[data-hub-toggle].hub-collapsed");var x=root.querySelector(".hub-expanded");',
      'if(!c||!x)return;var ex=!!ui.expanded;c.hidden=ex;x.hidden=!ex;',
      'c.setAttribute("aria-expanded",ex?"true":"false");',
      'var hub=x.querySelector(\'[data-screen="hub"]\');var rep=x.querySelector(\'[data-screen="report"]\');',
      'if(hub&&rep){var showReport=ex&&ui.screen==="report";hub.hidden=showReport;rep.hidden=!showReport;}}',
      'function save(){try{api.setState(ui);}catch(e){}}',
      'document.addEventListener("click",function(e){var t=e.target;if(!(t instanceof HTMLElement))return;',
      'var tg=t.closest("[data-hub-toggle]");if(tg){ui.expanded=!ui.expanded;if(!ui.expanded){ui.screen="hub";}save();paint();',
      'if(ui.expanded){var f=root.querySelector(".hub-expanded .hub-node:enabled, .hub-expanded .hub-node:not([disabled])");if(f)f.focus();}return;}',
      'var sc=t.closest("[data-screen-target]");if(sc){ui.expanded=true;ui.screen=sc.getAttribute("data-screen-target")==="report"?"report":"hub";save();paint();return;}',
      'var el=t.closest("[data-command]");if(!el||el.disabled)return;var cmd=el.getAttribute("data-command");if(!cmd)return;',
      'var msg={type:"command",command:cmd};var id=el.getAttribute("data-action-id");if(id)msg.actionId=id;',
      'api.postMessage(msg);});',
      'document.addEventListener("keydown",function(e){if(e.key==="Escape"&&ui.expanded){ui.expanded=false;ui.screen="hub";save();paint();}});',
      'window.addEventListener("message",function(e){var m=e.data;if(m&&m.type==="render"&&typeof m.html==="string"){root.innerHTML=m.html;paint();}});',
      '})();',
      '</script>',
      '</body>',
      '</html>',
    ].join('\n');
  }
}
