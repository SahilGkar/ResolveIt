import { escapeHtml } from '../dashboard/render.js';
import { lifecycleLabel, type RepairCardModel } from '../dashboard/cards.js';
import { approvalLabel } from '../dashboard/model.js';
import type { HubModel, HubNode } from './model.js';

export interface HubRenderInput {
  readonly model: HubModel;
  readonly workspaceName: string;
  readonly multiRoot: boolean;
  readonly aiSummary?: string;
  readonly cards: ReadonlyArray<RepairCardModel>;
  readonly canApply: boolean;
  readonly applySub: string;
  readonly verification: { readonly resolved: number; readonly remaining: number } | undefined;
}

const CSS = `
*{box-sizing:border-box}
body{margin:0;padding:0;background:var(--vscode-sideBar-background,var(--vscode-editor-background));color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);line-height:1.45}
.hub-root{padding:12px;display:flex;flex-direction:column;gap:10px}
.hub-collapsed{display:flex;align-items:center;gap:10px;width:100%;background:transparent;border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px 12px;cursor:pointer;color:var(--vscode-editor-foreground)}
.hub-collapsed:hover{background:var(--vscode-list-hoverBackground)}
.hub-collapsed:focus-visible,.hub-node:focus-visible,.hub-center:focus-visible,.hub-btn:focus-visible,.hub-back:focus-visible,.hub-link:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
.hub-gem{font-size:18px;color:var(--vscode-textLink-foreground);line-height:1}
.hub-collapsed .t{font-weight:600;font-size:13px}
.hub-collapsed .s{margin-left:auto;font-size:12px;color:var(--vscode-descriptionForeground)}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.dot.ok{background:var(--vscode-testing-iconPassed,var(--vscode-charts-green,#4caf50))}
.dot.warn{background:var(--vscode-editorWarning-foreground,#e5a50a)}
.dot.err{background:var(--vscode-testing-iconFailed,var(--vscode-errorForeground,#f14c4c))}
.dot.info{background:var(--vscode-textLink-foreground)}
.dot.neutral{background:var(--vscode-descriptionForeground)}
.dot.working{background:var(--vscode-progressBar-background,var(--vscode-textLink-foreground));animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
.radial{position:relative;height:308px;margin-top:2px}
.wires{position:absolute;inset:0;width:100%;height:100%}
.wires line{stroke:var(--vscode-panel-border);stroke-width:1}
.hub-node{position:absolute;transform:translate(-50%,-50%);width:32%;min-width:0;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:7px 8px;cursor:pointer;color:var(--vscode-editor-foreground);display:flex;flex-direction:column;gap:2px;align-items:flex-start;text-align:left}
button.hub-node:hover:enabled{background:var(--vscode-list-hoverBackground);border-color:var(--vscode-textLink-foreground)}
button.hub-node:disabled{opacity:.75;cursor:default}
.hub-node .l{font-size:12px;font-weight:700;line-height:1.25}
.hub-node .s{font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.3;overflow-wrap:anywhere}
.hub-node .b{position:absolute;top:-8px;right:-6px;font-size:10.5px;font-weight:700;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-radius:999px;padding:0 7px;line-height:16px}
.pos-top{left:50%;top:13%}
.pos-left{left:17%;top:50%}
.pos-right{left:83%;top:50%}
.pos-bottom{left:50%;top:87%}
.hub-center{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) rotate(45deg);width:78px;height:78px;background:var(--vscode-button-background);border:1px solid var(--vscode-button-background);border-radius:14px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.hub-center:hover{filter:brightness(1.12)}
.hub-center .in{transform:rotate(-45deg);display:flex;flex-direction:column;align-items:center;gap:0;color:var(--vscode-button-foreground)}
.hub-center .g{font-size:20px;line-height:1}
.hub-center .n{font-size:9px;font-weight:700;letter-spacing:.04em}
.hub-center.busy{animation:pulse 1.2s ease-in-out infinite}
.hub-caption{text-align:center;margin:0}
.hub-caption .t{font-weight:600;font-size:13px;margin:0}
.hub-caption .s{font-size:12px;color:var(--vscode-descriptionForeground);margin:2px 0 0;display:flex;align-items:center;justify-content:center;gap:6px}
.hub-notice{font-size:12px;color:var(--vscode-descriptionForeground);border:1px solid var(--vscode-panel-border);border-left:3px solid var(--vscode-editorWarning-foreground);border-radius:4px;padding:6px 8px;margin:0}
.hub-notice.err{border-left-color:var(--vscode-testing-iconFailed,var(--vscode-errorForeground,#f14c4c))}
.hub-links{display:flex;gap:4px;justify-content:center;font-size:12px;color:var(--vscode-descriptionForeground)}
.hub-link{background:none;border:none;color:var(--vscode-textLink-foreground);cursor:pointer;padding:2px 4px;font-size:12px}
.hub-link:hover{text-decoration:underline}
.hub-screen-head{display:flex;align-items:center;gap:8px}
.hub-back{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-panel-border);border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer}
.hub-back:hover{background:var(--vscode-button-secondaryHoverBackground)}
.hub-title{font-size:13px;font-weight:700;margin:0}
.hub-ai{font-size:12px;color:var(--vscode-descriptionForeground);margin:0}
.hub-counts{display:flex;gap:6px;flex-wrap:wrap}
.hub-count{font-size:11px;font-weight:600;border:1px solid var(--vscode-panel-border);border-radius:999px;padding:1px 8px;color:var(--vscode-descriptionForeground)}
.hub-card{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;background:var(--vscode-editor-background)}
.hub-card .k{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground)}
.hub-card .t{font-size:13px;font-weight:600;overflow-wrap:anywhere}
.hub-card .r{font-size:12px}
.hub-badge{display:inline-block;font-size:11px;font-weight:700;padding:0 8px;border-radius:999px;border:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground)}
.hub-badge.ok{color:var(--vscode-testing-iconPassed,var(--vscode-charts-green,#4caf50))}
.hub-badge.err{color:var(--vscode-testing-iconFailed,var(--vscode-errorForeground,#f14c4c))}
.hub-badge.info{color:var(--vscode-textLink-foreground)}
.hub-cardactions{display:flex;gap:8px}
.hub-btn{flex:1;border-radius:4px;padding:6px 10px;font-size:12.5px;font-weight:600;cursor:pointer}
.hub-btn.allow{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:1px solid transparent}
.hub-btn.allow:hover{background:var(--vscode-button-hoverBackground)}
.hub-btn.skip{background:transparent;color:var(--vscode-editor-foreground);border:1px solid var(--vscode-panel-border)}
.hub-btn.skip:hover{background:var(--vscode-list-hoverBackground)}
.hub-btn[aria-pressed="true"]{outline:2px solid var(--vscode-focusBorder);outline-offset:1px}
.hub-apply{width:100%;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:1px solid transparent;border-radius:4px;padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer}
.hub-apply:hover:enabled{background:var(--vscode-button-hoverBackground)}
.hub-apply:disabled{opacity:.45;cursor:default}
.hub-sub{font-size:11.5px;color:var(--vscode-descriptionForeground);margin:0;text-align:center}
.hub-foot{font-size:11px;color:var(--vscode-descriptionForeground);margin:0}
@media (prefers-reduced-motion:reduce){.dot.working,.hub-center.busy{animation:none}}
`;

function statusDot(kind: string): string {
  return `<span class="dot ${escapeHtml(kind)}" aria-hidden="true"></span>`;
}

function renderNode(node: HubNode, position: string): string {
  const badge = node.badge ? `<span class="b">${escapeHtml(node.badge)}</span>` : '';
  const action = node.screenTarget
    ? `data-screen-target="${escapeHtml(node.screenTarget)}"`
    : `data-command="${escapeHtml(node.command ?? '')}"`;
  const disabled = node.enabled ? '' : ' disabled';
  const reason = !node.enabled && node.disabledReason ? ` title="${escapeHtml(node.disabledReason)}" aria-describedby="hub-help"` : '';
  const label = node.enabled ? node.label : `${node.label} — ${node.sub}`;
  return [
    `<button class="hub-node ${position}" ${action}${disabled}${reason} aria-label="${escapeHtml(label)}">`,
    badge,
    `<span class="l">${escapeHtml(node.label)}</span>`,
    `<span class="s">${escapeHtml(node.sub)}</span>`,
    '</button>',
  ].join('');
}

function lifecycleBadgeClass(lifecycle: string): string {
  if (lifecycle === 'verified' || lifecycle === 'executed' || lifecycle === 'approved') {
    return 'ok';
  }
  if (lifecycle === 'failed' || lifecycle === 'denied') {
    return 'err';
  }
  return 'info';
}

function renderReportCard(card: RepairCardModel): string {
  const approvalText = approvalLabel(card.approval);
  const approvalExtra =
    approvalText === lifecycleLabel(card.lifecycle)
      ? ''
      : ` <span class="hub-badge">${escapeHtml(approvalText)}</span>`;
  const failed = card.lifecycle === 'failed' && card.executionError ? `<p class="r">Failed: ${escapeHtml(card.executionError)}</p>` : '';
  return [
    '<div class="hub-card">',
    `<span class="k">${escapeHtml(card.actionType)}</span>`,
    `<span class="t">${escapeHtml(card.target)}</span>`,
    `<p class="r"><b>Why:</b> ${escapeHtml(card.reason)}</p>`,
    `<p class="r"><b>Action:</b> ${escapeHtml(card.proposedChange)}</p>`,
    `<p class="r"><b>Scope:</b> ${escapeHtml(card.scope)} · <b>Risk:</b> ${escapeHtml(card.risk)}</p>`,
    `<p class="r"><span class="hub-badge ${lifecycleBadgeClass(card.lifecycle)}">${escapeHtml(lifecycleLabel(card.lifecycle))}</span>${approvalExtra}</p>`,
    failed,
    '<div class="hub-cardactions">',
    `<button class="hub-btn allow" data-command="resolveit.approveAction" data-action-id="${escapeHtml(card.id)}" aria-pressed="${card.approval === 'approved' ? 'true' : 'false'}" aria-label="Allow ${escapeHtml(card.target)}">Allow</button>`,
    `<button class="hub-btn skip" data-command="resolveit.skipAction" data-action-id="${escapeHtml(card.id)}" aria-pressed="${card.approval === 'denied' ? 'true' : 'false'}" aria-label="Skip ${escapeHtml(card.target)}">Skip</button>`,
    '</div>',
    '</div>',
  ].join('\n');
}

export function renderHubBody(input: HubRenderInput): string {
  const { model } = input;
  const byId = new Map(model.nodes.map((node) => [node.id, node] as const));
  const parts: string[] = ['<div class="hub-root">'];

  parts.push(
    `<button class="hub-collapsed" data-hub-toggle="1" aria-expanded="false" aria-label="ResolveIt — ${escapeHtml(model.centerStatus)}. Activate to open the Action Hub.">` +
      '<span class="hub-gem" aria-hidden="true">◆</span>' +
      `<span class="t">ResolveIt</span>${statusDot(model.statusKind)}` +
      `<span class="s">${escapeHtml(model.centerStatus)}</span>` +
      '</button>'
  );

  parts.push('<div class="hub-expanded" hidden>');
  parts.push('<div class="hub-screen" data-screen="hub">');
  parts.push('<div class="radial" role="group" aria-label="ResolveIt Action Hub">');
  parts.push(
    '<svg class="wires" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">' +
      '<line x1="50" y1="50" x2="50" y2="13"/>' +
      '<line x1="50" y1="50" x2="17" y2="50"/>' +
      '<line x1="50" y1="50" x2="83" y2="50"/>' +
      '<line x1="50" y1="50" x2="50" y2="87"/>' +
      '</svg>'
  );
  const top = byId.get('analyze');
  const left = byId.get('diagnostics');
  const right = byId.get('ai-report');
  const bottom = byId.get('apply');
  if (top) {
    parts.push(renderNode(top, 'pos-top'));
  }
  if (left) {
    parts.push(renderNode(left, 'pos-left'));
  }
  if (right) {
    parts.push(renderNode(right, 'pos-right'));
  }
  if (bottom) {
    parts.push(renderNode(bottom, 'pos-bottom'));
  }
  parts.push(
    `<button class="hub-center${model.busy ? ' busy' : ''}" data-hub-toggle="1" aria-expanded="true" aria-label="ResolveIt. Activate to collapse the Action Hub.">` +
      '<span class="in"><span class="g" aria-hidden="true">◆</span><span class="n">ResolveIt</span></span>' +
      '</button>'
  );
  parts.push('</div>');
  parts.push(
    '<div class="hub-caption" aria-live="polite">' +
      `<p class="t">${escapeHtml(input.workspaceName)}</p>` +
      `<p class="s">${statusDot(model.statusKind)}${escapeHtml(model.centerStatus)}</p>` +
      '</div>'
  );
  if (model.notice) {
    const err = model.statusKind === 'err' ? ' err' : '';
    parts.push(`<p class="hub-notice${err}">${escapeHtml(model.notice)}</p>`);
  }
  if (input.multiRoot) {
    parts.push('<p class="hub-sub">Multi-root workspace: analyzing the first folder.</p>');
  }
  if (input.verification) {
    const text =
      input.verification.remaining === 0
        ? `Verified: ${input.verification.resolved} resolved, nothing remaining.`
        : `${input.verification.resolved} resolved · ${input.verification.remaining} remain.`;
    parts.push(`<p class="hub-sub">${escapeHtml(text)}</p>`);
  }
  parts.push(
    '<div class="hub-links"><span id="hub-help">Details:</span>' +
      '<button class="hub-link" data-command="resolveit.diagnose">Diagnostics</button>·' +
      '<button class="hub-link" data-command="resolveit.environment">Environment</button>·' +
      '<button class="hub-link" data-command="resolveit.requirements">Requirements</button></div>'
  );
  parts.push('</div>');

  parts.push('<div class="hub-screen" data-screen="report" hidden>');
  parts.push(
    '<div class="hub-screen-head"><button class="hub-back" data-screen-target="hub" aria-label="Back to Action Hub">← Hub</button>' +
      '<p class="hub-title">AI Repair Report</p></div>'
  );
  if (!model.hasReport) {
    parts.push('<p class="hub-ai">No report yet. Prepare one from the hub.</p>');
    parts.push('<button class="hub-apply" data-command="resolveit.generateRepairPlan">Prepare AI Report</button>');
  } else {
    if (model.aiLine) {
      parts.push(`<p class="hub-ai">AI: ${escapeHtml(model.aiLine)}. Proposals are validated by ResolveIt and need your approval.</p>`);
    } else {
      parts.push('<p class="hub-ai">AI unavailable. This plan still works — review each change below.</p>');
      parts.push(
        '<div class="hub-cardactions"><button class="hub-btn skip" data-command="resolveit.retryAI">Retry AI</button>' +
          '<button class="hub-btn skip" data-screen-target="hub">Continue Without AI</button></div>'
      );
    }
    if (input.aiSummary) {
      parts.push(`<p class="hub-ai">${escapeHtml(input.aiSummary)}</p>`);
    }
    if (model.reportStale) {
      parts.push('<p class="hub-notice">Diagnostics changed since this report was prepared. Prepare a fresh report before applying.</p>');
    }
    const counts = model.reportCounts;
    if (counts) {
      parts.push(
        '<div class="hub-counts" aria-label="Report progress">' +
          `<span class="hub-count">Detected ${counts.detected}</span>` +
          `<span class="hub-count">Proposed ${counts.proposed}</span>` +
          `<span class="hub-count">Approved ${counts.approved}</span>` +
          `<span class="hub-count">Executed ${counts.executed}</span>` +
          `<span class="hub-count">Verified ${counts.verified}</span></div>`
      );
    }
    for (const card of input.cards) {
      parts.push(renderReportCard(card));
    }
    const applyDisabled = input.canApply ? '' : ' disabled';
    parts.push(`<button class="hub-apply" data-command="resolveit.applyApprovedRepairs"${applyDisabled}>Apply Approved Changes</button>`);
    parts.push(`<p class="hub-sub">${escapeHtml(input.applySub)}</p>`);
  }
  parts.push('</div>');

  parts.push('</div>');
  parts.push('<p class="hub-foot">Analyze → Review → Approve → Apply → Verify. AI proposals are never executed directly.</p>');
  parts.push('</div>');
  return parts.join('\n');
}

export function hubStyles(): string {
  return CSS;
}
