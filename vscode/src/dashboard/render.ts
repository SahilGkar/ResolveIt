import { approvalLabel, type DashboardModel } from './model.js';
import { lifecycleLabel, type RepairCardModel } from './cards.js';

export interface DashboardRenderInput {
  readonly model: DashboardModel;
  readonly workspaceName: string;
  readonly multiRoot: boolean;
  readonly ai: { readonly provider: string; readonly model: string; readonly available: boolean } | undefined;
  readonly aiSummary?: string;
  readonly cards: ReadonlyArray<RepairCardModel>;
  readonly verification:
    | { readonly resolved: number; readonly remaining: number }
    | undefined;
  readonly execution: { readonly succeeded: number; readonly failed: number } | undefined;
  readonly environmentReady?: boolean;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
*{box-sizing:border-box}
body{margin:0;padding:0;background:var(--vscode-sideBar-background,var(--vscode-editor-background));color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);line-height:1.45}
.root{padding:12px;display:flex;flex-direction:column;gap:12px}
.header{display:flex;flex-direction:column;gap:6px}
.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--vscode-descriptionForeground);margin:0}
.project{font-size:15px;font-weight:600;margin:0;overflow-wrap:anywhere}
.statusrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--vscode-panel-border)}
.pill .dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex:none}
.pill.ok{color:var(--vscode-testing-iconPassed,var(--vscode-charts-green,#4caf50))}
.pill.warn{color:var(--vscode-editorWarning-foreground,#e5a50a)}
.pill.err{color:var(--vscode-testing-iconFailed,var(--vscode-errorForeground,#f14c4c))}
.pill.info{color:var(--vscode-textLink-foreground)}
.pill.neutral{color:var(--vscode-descriptionForeground)}
.title{font-size:14px;font-weight:600;margin:0}
.desc{margin:0;color:var(--vscode-descriptionForeground);font-size:12.5px}
.primary{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:1px solid transparent;border-radius:4px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;width:100%}
.primary:hover{background:var(--vscode-button-hoverBackground)}
.primary:disabled{opacity:.45;cursor:default}
.primary:focus-visible,.secondary:focus-visible,.allow:focus-visible,.skip:focus-visible,.linkbtn:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
.secondaryrow{display:flex;gap:8px;flex-wrap:wrap}
.secondary{display:inline-flex;align-items:center;gap:6px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-panel-border);border-radius:4px;padding:5px 10px;font-size:12px;font-weight:500;cursor:pointer}
.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
.section{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--vscode-editor-background)}
.section h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--vscode-descriptionForeground);margin:0}
.statgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px}
.stat{display:flex;flex-direction:column;gap:1px}
.stat .k{font-size:11px;color:var(--vscode-descriptionForeground)}
.stat .v{font-size:13px;font-weight:600}
.card{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;background:var(--vscode-sideBar-background,var(--vscode-editor-background))}
.card .atype{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--vscode-descriptionForeground)}
.card .target{font-size:13.5px;font-weight:600;overflow-wrap:anywhere}
.card .row{font-size:12.5px}
.card .row b{font-weight:600}
.badge{display:inline-block;font-size:11px;font-weight:700;padding:1px 8px;border-radius:999px;border:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground)}
.badge.ok{color:var(--vscode-testing-iconPassed,var(--vscode-charts-green,#4caf50))}
.badge.err{color:var(--vscode-testing-iconFailed,var(--vscode-errorForeground,#f14c4c))}
.badge.info{color:var(--vscode-textLink-foreground)}
.cardactions{display:flex;gap:8px}
.allow{flex:1;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:1px solid transparent;border-radius:4px;padding:6px 10px;font-weight:600;cursor:pointer}
.allow:hover{background:var(--vscode-button-hoverBackground)}
.allow[aria-pressed="true"]{outline:2px solid var(--vscode-testing-iconPassed,var(--vscode-charts-green,#4caf50));outline-offset:1px}
.skip{flex:1;background:transparent;color:var(--vscode-editor-foreground);border:1px solid var(--vscode-panel-border);border-radius:4px;padding:6px 10px;font-weight:500;cursor:pointer}
.skip:hover{background:var(--vscode-list-hoverBackground)}
.skip[aria-pressed="true"]{outline:2px solid var(--vscode-descriptionForeground);outline-offset:1px}
.progress{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--vscode-descriptionForeground)}
.spinner{width:14px;height:14px;flex:none;border-radius:50%;border:2px solid var(--vscode-panel-border);border-top-color:var(--vscode-progressBar-background,var(--vscode-textLink-foreground));animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spinner{animation:none}}
.empty{color:var(--vscode-descriptionForeground);font-size:12.5px;margin:0}
.linkbtn{background:none;border:none;color:var(--vscode-textLink-foreground);cursor:pointer;padding:0;font-size:12.5px;text-align:left}
.linkbtn:hover{text-decoration:underline}
.notice{font-size:11.5px;color:var(--vscode-descriptionForeground);margin:0}
.footer{font-size:11.5px;color:var(--vscode-descriptionForeground)}
`;

function statusPill(kind: string): { cls: string; text: string } {
  switch (kind) {
    case 'HEALTHY':
    case 'RESOLVED':
      return { cls: 'ok', text: kind === 'HEALTHY' ? 'Healthy' : 'Resolved' };
    case 'PROBLEMS_FOUND':
    case 'AI_ANALYSIS_AVAILABLE':
      return { cls: 'warn', text: 'Issues found' };
    case 'REPAIR_PLAN_READY':
    case 'AWAITING_APPROVAL':
    case 'APPROVED':
      return { cls: 'info', text: 'Awaiting approval' };
    case 'ANALYZING':
    case 'APPLYING':
    case 'VERIFICATION':
      return { cls: 'info', text: 'Working' };
    case 'PARTIALLY_RESOLVED':
      return { cls: 'warn', text: 'Partially resolved' };
    case 'FAILED':
      return { cls: 'err', text: 'Failed' };
    default:
      return { cls: 'neutral', text: 'Not scanned' };
  }
}

function lifecycleBadgeClass(lifecycle: string): string {
  if (lifecycle === 'verified' || lifecycle === 'executed' || lifecycle === 'approved') {
    return 'ok';
  }
  if (lifecycle === 'failed' || lifecycle === 'denied') {
    return 'err';
  }
  if (lifecycle === 'awaiting-approval' || lifecycle === 'proposed' || lifecycle === 'executing') {
    return 'info';
  }
  return '';
}

export function renderDashboardBody(input: DashboardRenderInput): string {
  const { model } = input;
  const pill = statusPill(model.kind);
  const parts: string[] = [];

  parts.push('<div class="root">');
  parts.push('<div class="header" aria-live="polite">');
  parts.push('<p class="eyebrow">ResolveIt</p>');
  parts.push(`<p class="project">${escapeHtml(input.workspaceName)}</p>`);
  if (input.multiRoot) {
    parts.push('<p class="notice">Multi-root workspace: analyzing the first folder.</p>');
  }
  parts.push(
    `<div class="statusrow"><span class="pill ${pill.cls}"><span class="dot" aria-hidden="true"></span>${escapeHtml(pill.text)}</span></div>`
  );
  parts.push(`<p class="title">${escapeHtml(model.title)}</p>`);
  parts.push(`<p class="desc">${escapeHtml(model.description)}</p>`);
  parts.push('</div>');

  if (model.showProgress) {
    parts.push(
      `<div class="progress" role="status"><span class="spinner" aria-hidden="true"></span><span>${escapeHtml(model.progressMessage ?? 'Working…')}</span></div>`
    );
  }

  if (model.primary) {
    const disabled = model.primary.enabled ? '' : ' disabled';
    const label = model.primary.enabled ? model.primary.label : `${model.primary.label} (select an action below)`;
    parts.push(
      `<button class="primary" data-command="${escapeHtml(model.primary.command)}"${disabled} aria-label="${escapeHtml(label)}">${escapeHtml(model.primary.label)}</button>`
    );
  }
  if (model.secondary.length > 0) {
    parts.push('<div class="secondaryrow">');
    for (const action of model.secondary) {
      parts.push(
        `<button class="secondary" data-command="${escapeHtml(action.command)}">${escapeHtml(action.label)}</button>`
      );
    }
    parts.push('</div>');
  }

  parts.push('<div class="section" aria-label="Project status">');
  parts.push('<h2>Project status</h2>');
  parts.push('<div class="statgrid">');
  parts.push(
    `<div class="stat"><span class="k">Environment</span><span class="v">${input.environmentReady === true ? 'Ready' : input.environmentReady === false ? 'Issues' : 'Unknown'}</span></div>`
  );
  parts.push(
    `<div class="stat"><span class="k">Requirements</span><span class="v">${model.counts.requirements}</span></div>`
  );
  parts.push(
    `<div class="stat"><span class="k">Problems</span><span class="v">${model.counts.blocking} blocking · ${model.counts.total} total</span></div>`
  );
  const planText = model.plan
    ? model.plan.stale
      ? 'Stale — re-analyze'
      : `${model.plan.approvedCount}/${model.plan.actionCount} approved`
    : 'None yet';
  parts.push(`<div class="stat"><span class="k">Repair plan</span><span class="v">${escapeHtml(planText)}</span></div>`);
  parts.push('</div>');
  if (model.counts.warnings > 0 || model.counts.errors > 0) {
    parts.push(
      `<p class="desc">${model.counts.errors} error(s), ${model.counts.warnings} warning(s). <button class="linkbtn" data-command="resolveit.reviewProblems">Review problems</button></p>`
    );
  }
  parts.push('</div>');

  parts.push('<div class="section" aria-label="AI assistant">');
  parts.push('<h2>AI assistant</h2>');
  if (!input.ai || input.ai.provider === 'none') {
    parts.push('<p class="desc">Not configured. Deterministic ResolveIt diagnostics still work.</p>');
    parts.push('<div class="secondaryrow"><button class="secondary" data-command="resolveit.openSettings">Configure AI</button></div>');
  } else if (!input.ai.available) {
    parts.push(
      `<p class="desc">Unavailable (${escapeHtml(input.ai.provider)} · ${escapeHtml(input.ai.model)}). ResolveIt can still use deterministic diagnostics.</p>`
    );
    parts.push(
      '<div class="secondaryrow"><button class="secondary" data-command="resolveit.retryAI">Retry AI</button><button class="secondary" data-command="resolveit.reviewProblems">Continue Without AI</button></div>'
    );
  } else {
    parts.push(
      `<p class="desc">Available (${escapeHtml(input.ai.provider)} · ${escapeHtml(input.ai.model)}). AI proposals are never executed directly — you approve each change first.</p>`
    );
    if (input.aiSummary) {
      parts.push(`<p class="desc">${escapeHtml(input.aiSummary)}</p>`);
    }
    if (model.kind === 'AI_ANALYSIS_AVAILABLE' || model.kind === 'PROBLEMS_FOUND') {
      parts.push(
        '<div class="secondaryrow"><button class="secondary" data-command="resolveit.generateRepairPlan">Generate Repair Plan</button></div>'
      );
    }
  }
  parts.push('</div>');

  if (input.cards.length > 0) {
    parts.push('<div class="section" aria-label="Proposed repairs">');
    parts.push(`<h2>Proposed repairs (${input.cards.length})</h2>`);
    if (model.plan?.stale === true) {
      parts.push('<p class="desc">Diagnostics changed since this plan was created. Re-analyze before applying.</p>');
    }
    parts.push('<p class="desc">Review each change before anything is modified. Nothing runs until you apply approved repairs.</p>');
    for (const card of input.cards) {
      parts.push(renderCard(card));
    }
    parts.push('</div>');
  }

  if (input.execution) {
    parts.push('<div class="section" aria-label="Repair result">');
    parts.push('<h2>What happened</h2>');
    parts.push(
      `<p class="desc">${input.execution.succeeded} succeeded, ${input.execution.failed} failed. Failed repairs never appear as successful.</p>`
    );
    parts.push('</div>');
  }

  if (input.verification) {
    parts.push('<div class="section" aria-label="Verification">');
    parts.push('<h2>Verification</h2>');
    if (input.verification.remaining === 0) {
      parts.push(
        `<p class="desc">Verified: ${input.verification.resolved} resolved, nothing remaining.</p>`
      );
    } else {
      parts.push(
        `<p class="desc">${input.verification.resolved} resolved, ${input.verification.remaining} remaining. <button class="linkbtn" data-command="resolveit.verify">Verify again</button></p>`
      );
    }
    parts.push('</div>');
  }

  parts.push('<div class="section" aria-label="Details">');
  parts.push('<h2>Details</h2>');
  parts.push(
    '<p class="desc"><button class="linkbtn" data-command="resolveit.diagnose">Diagnostics</button> · ' +
      '<button class="linkbtn" data-command="resolveit.environment">Environment</button> · ' +
      '<button class="linkbtn" data-command="resolveit.requirements">Requirements</button></p>'
  );
  parts.push('</div>');

  parts.push('<p class="footer">Analyze → Review findings → Generate AI plan → Review repairs → Approve → Apply → Verify. AI proposals are never executed directly.</p>');
  parts.push('</div>');
  return parts.join('\n');
}

function renderCard(card: RepairCardModel): string {
  const badge = lifecycleBadgeClass(card.lifecycle);
  const allowPressed = card.approval === 'approved' ? 'true' : 'false';
  const skipPressed = card.approval === 'denied' ? 'true' : 'false';
  const approvalBadge =
    card.lifecycle === 'approved' || card.lifecycle === 'denied'
      ? ''
      : ` <span class="badge">${escapeHtml(approvalLabel(card.approval))}</span>`;
  const failed = card.lifecycle === 'failed' && card.executionError ? `<p class="desc">Failed: ${escapeHtml(card.executionError)}</p>` : '';
  return [
    '<div class="card">',
    `<span class="atype">${escapeHtml(card.actionType)}</span>`,
    `<span class="target">${escapeHtml(card.target)}</span>`,
    `<p class="row"><b>Why:</b> ${escapeHtml(card.reason)}</p>`,
    `<p class="row"><b>Action:</b> ${escapeHtml(card.proposedChange)}</p>`,
    `<p class="row"><b>Scope:</b> ${escapeHtml(card.scope)} · <b>Risk:</b> ${escapeHtml(card.risk)}${card.reversible ? ' · Reversible' : ''}</p>`,
    `<p class="row"><b>Source:</b> ${escapeHtml(card.source)}</p>`,
    `<p class="row"><span class="badge ${badge}">${escapeHtml(lifecycleLabel(card.lifecycle))}</span>${approvalBadge}</p>`,
    failed,
    '<div class="cardactions">',
    `<button class="allow" data-command="resolveit.approveAction" data-action-id="${escapeHtml(card.id)}" aria-pressed="${allowPressed}" aria-label="Allow ${escapeHtml(card.target)}">Allow</button>`,
    `<button class="skip" data-command="resolveit.skipAction" data-action-id="${escapeHtml(card.id)}" aria-pressed="${skipPressed}" aria-label="Skip ${escapeHtml(card.target)}">Skip</button>`,
    '</div>',
    '</div>',
  ].join('\n');
}

export function dashboardStyles(): string {
  return CSS;
}
