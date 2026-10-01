export function workflowStyles(): string {
  return `
* { box-sizing: border-box; }
body { 
  margin: 0; 
  padding: 0; 
  background: var(--vscode-editor-background); 
  color: var(--vscode-editor-foreground); 
  font-family: var(--vscode-font-family); 
  font-size: var(--vscode-font-size, 13px); 
  line-height: 1.5; 
}
.wf-root { padding: 16px; max-width: 720px; margin: 0 auto; }
.wf-loading { text-align: center; color: var(--vscode-descriptionForeground); padding: 40px; }
.wf-header { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--vscode-panel-border); }
.wf-title { font-size: 20px; font-weight: 600; margin: 0; }
.wf-subtitle { font-size: 13px; color: var(--vscode-descriptionForeground); margin: 0; }
.wf-step-indicator { display: flex; gap: 8px; margin-bottom: 24px; flex-wrap: wrap; }
.wf-step { 
  padding: 6px 12px; 
  border-radius: 999px; 
  font-size: 12px; 
  font-weight: 500; 
  background: var(--vscode-badge-background); 
  color: var(--vscode-badge-foreground); 
  opacity: 0.5; 
}
.wf-step.active { opacity: 1; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.wf-step.done { opacity: 0.8; background: var(--vscode-testing-iconPassed, #4caf50); color: white; }
.wf-section { margin-bottom: 24px; }
.wf-section-title { font-size: 14px; font-weight: 600; margin: 0 0 12px; }
.wf-card { 
  background: var(--vscode-editor-background); 
  border: 1px solid var(--vscode-panel-border); 
  border-radius: 8px; 
  padding: 16px; 
  margin-bottom: 12px; 
}
.wf-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.wf-card-title { font-weight: 600; font-size: 13px; }
.wf-card-subtitle { font-size: 12px; color: var(--vscode-descriptionForeground); }
.wf-badge { 
  display: inline-block; 
  padding: 2px 8px; 
  border-radius: 999px; 
  font-size: 11px; 
  font-weight: 600; 
  background: var(--vscode-badge-background); 
  color: var(--vscode-badge-foreground); 
}
.wf-badge.success { background: var(--vscode-testing-iconPassed, #4caf50); color: white; }
.wf-badge.warning { background: var(--vscode-editorWarning-foreground, #e5a50a); color: white; }
.wf-badge.error { background: var(--vscode-testing-iconFailed, #f14c4c); color: white; }
.wf-badge.info { background: var(--vscode-textLink-foreground); color: white; }
.wf-btn { 
  padding: 10px 16px; 
  border-radius: 4px; 
  font-size: 13px; 
  font-weight: 600; 
  cursor: pointer; 
  border: 1px solid transparent; 
  transition: background 0.1s; 
}
.wf-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.wf-btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.wf-btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-color: var(--vscode-panel-border); }
.wf-btn.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.wf-btn.danger { background: var(--vscode-errorForeground, #f14c4c); color: white; }
.wf-btn.danger:hover:not(:disabled) { opacity: 0.9; }
.wf-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.wf-btn-group { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.wf-progress { margin-top: 12px; }
.wf-progress-bar { 
  height: 6px; 
  background: var(--vscode-progressBar-background, var(--vscode-button-background)); 
  border-radius: 3px; 
  overflow: hidden; 
}
.wf-progress-fill { 
  height: 100%; 
  background: var(--vscode-button-background); 
  transition: width 0.3s ease; 
}
.wf-progress-text { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px; display: flex; justify-content: space-between; }
.wf-action-list { display: flex; flex-direction: column; gap: 8px; }
.wf-action-item { 
  display: flex; 
  align-items: center; 
  gap: 12px; 
  padding: 12px; 
  background: var(--vscode-editor-background); 
  border: 1px solid var(--vscode-panel-border); 
  border-radius: 6px; 
}
.wf-action-checkbox { width: 18px; height: 18px; cursor: pointer; }
.wf-action-info { flex: 1; min-width: 0; }
.wf-action-label { font-weight: 500; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-action-desc { font-size: 12px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-action-status { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
.wf-action-status.pending { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.wf-action-status.approved { background: var(--vscode-testing-iconPassed, #4caf50); color: white; }
.wf-action-status.denied { background: var(--vscode-testing-iconFailed, #f14c4c); color: white; }
.wf-action-status.running { background: var(--vscode-progressBar-background, var(--vscode-textLink-foreground)); color: white; animation: pulse 1.5s ease-in-out infinite; }
.wf-action-status.success { background: var(--vscode-testing-iconPassed, #4caf50); color: white; }
.wf-action-status.failed { background: var(--vscode-testing-iconFailed, #f14c4c); color: white; }
@keyframes pulse { 50% { opacity: 0.5; } }
.wf-error { 
  background: var(--vscode-inputValidation-errorBackground, rgba(241, 76, 76, 0.1)); 
  border: 1px solid var(--vscode-inputValidation-errorBorder, #f14c4c); 
  border-radius: 6px; 
  padding: 12px; 
  color: var(--vscode-inputValidation-errorForeground, #f14c4c); 
  margin-bottom: 16px; 
}
.wf-error-title { font-weight: 600; margin-bottom: 4px; }
.wf-ai-options { display: flex; flex-direction: column; gap: 8px; }
.wf-ai-option { 
  display: flex; 
  align-items: center; 
  gap: 12px; 
  padding: 12px; 
  border: 1px solid var(--vscode-panel-border); 
  border-radius: 6px; 
  cursor: pointer; 
  transition: border-color 0.1s, background 0.1s; 
}
.wf-ai-option:hover { border-color: var(--vscode-textLink-foreground); background: var(--vscode-list-hoverBackground); }
.wf-ai-option.selected { border-color: var(--vscode-button-background); background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.wf-ai-option input { accent-color: var(--vscode-button-background); }
.wf-ai-option-info { flex: 1; }
.wf-ai-option-label { font-weight: 500; font-size: 13px; }
.wf-ai-option-desc { font-size: 12px; color: var(--vscode-descriptionForeground); opacity: 0.8; }
.wf-ai-option-status { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
.wf-ai-option-status.available { background: var(--vscode-testing-iconPassed, #4caf50); color: white; }
.wf-ai-option-status.unavailable { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.wf-project-info { display: flex; flex-direction: column; gap: 8px; }
.wf-project-row { display: flex; gap: 12px; align-items: center; }
.wf-project-label { font-weight: 500; min-width: 80px; }
.wf-project-value { font-family: var(--vscode-editor-font-family); font-size: 12px; color: var(--vscode-descriptionForeground); word-break: break-all; }
.wf-divider { height: 1px; background: var(--vscode-panel-border); margin: 16px 0; }
.wf-footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border); display: flex; gap: 8px; justify-content: space-between; align-items: center; flex-wrap: wrap; }
.wf-nav { display: flex; gap: 8px; }
.wf-empty { text-align: center; color: var(--vscode-descriptionForeground); padding: 24px; font-size: 13px; }
`;
}

export function renderWorkflowHtml(model: any): string {
  const steps: Array<{ id: string; label: string }> = [
    { id: 'ai-mode', label: 'AI Mode' },
    { id: 'project', label: 'Project' },
    { id: 'analyze', label: 'Analyze' },
    { id: 'status', label: 'Status' },
    { id: 'repair-plan', label: 'Repair Plan' },
    { id: 'apply', label: 'Apply' },
    { id: 'verify', label: 'Verify' },
    { id: 'success', label: 'Done' },
  ];

  const stepIndex = steps.findIndex(s => s.id === model.currentStep);
  const stepHtml = steps.map((step, i) => {
    let cls = 'wf-step';
    if (i < stepIndex) cls += ' done';
    else if (i === stepIndex) cls += ' active';
    return `<span class="${cls}">${escapeHtml(step.label)}</span>`;
  }).join('');

  let contentHtml = '';
  switch (model.currentStep) {
    case 'ai-mode':
      contentHtml = renderAiModeStep(model);
      break;
    case 'project':
      contentHtml = renderProjectStep(model);
      break;
    case 'analyze':
      contentHtml = renderAnalyzeStep(model);
      break;
    case 'status':
      contentHtml = renderStatusStep(model);
      break;
    case 'repair-plan':
      contentHtml = renderRepairPlanStep(model);
      break;
    case 'apply':
      contentHtml = renderApplyStep(model);
      break;
    case 'verify':
      contentHtml = renderVerifyStep(model);
      break;
    case 'success':
      contentHtml = renderSuccessStep(model);
      break;
    case 'failed':
      contentHtml = renderFailedStep(model);
      break;
  }

  const navHtml = `
    <div class="wf-nav">
      ${model.canGoBack ? '<button class="wf-btn secondary" data-command="workflow.goBack">← Back</button>' : ''}
      ${model.canGoForward && model.currentStep !== 'success' && model.currentStep !== 'failed' ? '<button class="wf-btn primary" data-command="workflow.goForward">Next →</button>' : ''}
    </div>
  `;

  return `
    <div class="wf-root">
      <div class="wf-header">
        <div>
          <h1 class="wf-title">ResolveIt</h1>
          <p class="wf-subtitle">${escapeHtml(model.workspaceName)}</p>
        </div>
      </div>
      <div class="wf-step-indicator" role="navigation" aria-label="Workflow steps">${stepHtml}</div>
      ${model.errorMessage ? `<div class="wf-error"><div class="wf-error-title">Error</div><div>${escapeHtml(model.errorMessage)}</div></div>` : ''}
      ${contentHtml}
      <div class="wf-footer">${navHtml}</div>
    </div>
  `;
}

function renderAiModeStep(model: any): string {
  const optionsHtml = model.aiModeOptions.map((opt: any) => `
    <label class="wf-ai-option ${model.aiMode === opt.id ? 'selected' : ''}">
      <input type="radio" name="aiMode" value="${opt.id}" ${model.aiMode === opt.id ? 'checked' : ''} data-command="workflow.setAiMode" data-step="${opt.id}">
      <div class="wf-ai-option-info">
        <div class="wf-ai-option-label">${escapeHtml(opt.label)}</div>
        <div class="wf-ai-option-desc">${escapeHtml(opt.description)}</div>
      </div>
      <span class="wf-ai-option-status ${opt.available ? 'available' : 'unavailable'}">
        ${opt.available ? 'Available' : 'Not configured'}
      </span>
    </label>
  `).join('');

  return `
    <div class="wf-section">
      <h2 class="wf-section-title">Select AI Mode</h2>
      <p class="wf-card-subtitle">Choose how ResolveIt should generate repair plans. You can change this later in settings.</p>
      <div class="wf-ai-options">${optionsHtml}</div>
    </div>
  `;
}

function renderProjectStep(model: any): string {
  return `
    <div class="wf-section">
      <h2 class="wf-section-title">Project</h2>
      <div class="wf-card wf-project-info">
        <div class="wf-project-row">
          <span class="wf-project-label">Name</span>
          <span class="wf-project-value">${escapeHtml(model.projectName)}</span>
        </div>
        <div class="wf-project-row">
          <span class="wf-project-label">Path</span>
          <span class="wf-project-value">${escapeHtml(model.projectRoot)}</span>
        </div>
      </div>
      <div class="wf-btn-group">
        <button class="wf-btn primary" data-command="workflow.analyze">Analyze Project</button>
      </div>
    </div>
  `;
}

function renderAnalyzeStep(model: any): string {
  const { analyzeProgress } = model;
  const stepsHtml = analyzeProgress.steps.map((step: any, i: number) => `
    <div class="wf-action-item" style="background: transparent; border: none; padding: 8px 0;">
      <span style="width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; 
        background: ${step.done ? 'var(--vscode-testing-iconPassed, #4caf50)' : step.current ? 'var(--vscode-button-background)' : 'var(--vscode-panel-border)'}; 
        color: ${step.done || step.current ? 'white' : 'var(--vscode-descriptionForeground)'};">
        ${step.done ? '✓' : step.current ? '⟳' : (i + 1)}
      </span>
      <div class="wf-action-info">
        <div class="wf-action-label">${escapeHtml(step.label)}</div>
      </div>
    </div>
  `).join('');

  const completed = analyzeProgress.completed;

  return `
    <div class="wf-section">
      <h2 class="wf-section-title">Analyzing Project</h2>
      <div class="wf-card">
        <div class="wf-action-list">${stepsHtml}</div>
        ${!completed ? `
          <div class="wf-progress">
            <div class="wf-progress-bar"><div class="wf-progress-fill" style="width: ${analyzeProgress.steps.filter((s: any) => s.done).length / analyzeProgress.steps.length * 100}%"></div></div>
            <div class="wf-progress-text"><span>${escapeHtml(analyzeProgress.stage)}</span></div>
          </div>
        ` : ''}
      </div>
      <div class="wf-btn-group">
        ${!completed ? '<button class="wf-btn primary" disabled>Analyzing…</button>' : '<button class="wf-btn primary" data-command="workflow.goForward">Continue to Status</button>'}
        ${!completed ? '<button class="wf-btn secondary" data-command="workflow.cancelAnalyze">Cancel</button>' : ''}
      </div>
    </div>
  `;
}

function renderStatusStep(model: any): string {
  const { statusSummary } = model;
  return `
    <div class="wf-section">
      <h2 class="wf-section-title">Project Status</h2>
      <div class="wf-card">
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="wf-badge success">✓</span>
            <span>Requirements: <strong>${statusSummary.requirementsTotal}</strong></span>
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="wf-badge warning">⚠</span>
            <span>Issues found: <strong>${statusSummary.issuesFound}</strong></span>
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="wf-badge error">✗</span>
            <span>Blocking issues: <strong>${statusSummary.blockingIssues}</strong></span>
          </div>
        </div>
      </div>
      <div class="wf-btn-group">
        ${statusSummary.blockingIssues > 0 
          ? '<button class="wf-btn primary" data-command="workflow.generatePlan">Generate Repair Plan</button>' 
          : '<button class="wf-btn primary" data-command="workflow.goForward">Project Healthy - Continue</button>'}
        <button class="wf-btn secondary" data-command="workflow.reanalyze">Re-analyze</button>
      </div>
    </div>
  `;
}

function renderRepairPlanStep(model: any): string {
  const { repairPlan } = model;
  if (!repairPlan.plan) {
    return `
      <div class="wf-section">
        <h2 class="wf-section-title">Repair Plan</h2>
        <div class="wf-empty">No repair plan generated yet.</div>
        <div class="wf-btn-group">
          <button class="wf-btn primary" data-command="workflow.generatePlan">Generate Repair Plan</button>
        </div>
      </div>
    `;
  }

  const actionsHtml = repairPlan.actions.map((item: any, _idx: number) => {
    const { action, approved, executionResult } = item;
    let statusClass = 'pending';
    let statusLabel = 'Awaiting approval';
    if (executionResult) {
      statusClass = executionResult.success ? 'success' : 'failed';
      statusLabel = executionResult.success ? 'Executed' : `Failed: ${executionResult.error ?? 'Unknown error'}`;
    } else if (approved) {
      statusClass = 'approved';
      statusLabel = 'Approved';
    }
    return `
      <div class="wf-action-item">
        <input type="checkbox" class="wf-action-checkbox" ${approved ? 'checked' : ''} 
          ${executionResult ? 'disabled' : ''} 
          data-command="workflow.toggleApproval" data-action-id="${action.id}">
        <div class="wf-action-info">
          <div class="wf-action-label">${escapeHtml(action.description)}</div>
          <div class="wf-action-desc">${escapeHtml(action.type)} · ${escapeHtml(action.permissionLevel)}</div>
        </div>
        <span class="wf-action-status ${statusClass}">${escapeHtml(statusLabel)}</span>
      </div>
    `;
  }).join('');

  return `
    <div class="wf-section">
      <h2 class="wf-section-title">Repair Plan <span class="wf-badge">${repairPlan.approvedCount} / ${repairPlan.totalCount} approved</span></h2>
      <div class="wf-card">
        <div class="wf-action-list">${actionsHtml}</div>
      </div>
      <div class="wf-btn-group">
        <button class="wf-btn primary" data-command="workflow.approveAll" ${repairPlan.approvedCount === repairPlan.totalCount ? 'disabled' : ''}>Approve All</button>
        <button class="wf-btn secondary" data-command="workflow.denyAll" ${repairPlan.approvedCount === 0 ? 'disabled' : ''}>Deny All</button>
        <button class="wf-btn primary" data-command="workflow.apply" ${repairPlan.approvedCount === 0 ? 'disabled' : ''}>Apply Approved Changes</button>
      </div>
    </div>
  `;
}

function renderApplyStep(model: any): string {
  const { applyProgress } = model;
  const actionsHtml = applyProgress.actions.map((action: any) => `
    <div class="wf-action-item">
      <div style="width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; 
        background: ${action.status === 'success' ? 'var(--vscode-testing-iconPassed, #4caf50)' : action.status === 'failed' ? 'var(--vscode-testing-iconFailed, #f14c4c)' : action.status === 'running' ? 'var(--vscode-button-background)' : 'var(--vscode-panel-border)'}; 
        color: ${action.status === 'pending' ? 'var(--vscode-descriptionForeground)' : 'white'};">
        ${action.status === 'success' ? '✓' : action.status === 'failed' ? '✗' : action.status === 'running' ? '⟳' : '○'}
      </div>
      <div class="wf-action-info">
        <div class="wf-action-label">${escapeHtml(action.label)}</div>
        ${action.error ? `<div class="wf-action-desc" style="color: var(--vscode-testing-iconFailed, #f14c4c);">Error: ${escapeHtml(action.error)}</div>` : ''}
      </div>
      <span class="wf-action-status ${action.status}">${escapeHtml(action.status)}</span>
    </div>
  `).join('');

  const completed = applyProgress.completed;
  const total = applyProgress.total;

  return `
    <div class="wf-section">
      <h2 class="wf-section-title">Applying Changes</h2>
      <div class="wf-card">
        <div class="wf-progress">
          <div class="wf-progress-bar"><div class="wf-progress-fill" style="width: ${total > 0 ? completed / total * 100 : 0}%"></div></div>
          <div class="wf-progress-text"><span>${completed} / ${total} completed</span></div>
        </div>
        <div class="wf-action-list">${actionsHtml}</div>
      </div>
      <div class="wf-btn-group">
        <button class="wf-btn primary" data-command="workflow.goForward" ${completed < total ? 'disabled' : ''}>Continue to Verify</button>
      </div>
    </div>
  `;
}

function renderVerifyStep(model: any): string {
  const { verifyResult } = model;
  const success = verifyResult.success;
  return `
    <div class="wf-section">
      <h2 class="wf-section-title">Verification ${success ? '<span class="wf-badge success">Passed</span>' : '<span class="wf-badge error">Failed</span>'}</h2>
      <div class="wf-card">
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="wf-badge ${success ? 'success' : 'warning'}">${success ? '✓' : '⚠'}</span>
            <span>${escapeHtml(verifyResult.details)}</span>
          </div>
          ${!success && verifyResult.remaining > 0 ? `
            <div style="color: var(--vscode-descriptionForeground); font-size: 13px;">
              ${verifyResult.remaining} blocking issue(s) remain. You can return to the repair plan to address them.
            </div>
          ` : ''}
        </div>
      </div>
      <div class="wf-btn-group">
        ${success ? `
          <button class="wf-btn primary" data-command="workflow.testProject">Test Project</button>
          <button class="wf-btn secondary" data-command="workflow.goForward">Done</button>
        ` : `
          <button class="wf-btn primary" data-command="workflow.returnToPlan">Return to Repair Plan</button>
          <button class="wf-btn secondary" data-command="workflow.reanalyze">Re-analyze</button>
        `}
      </div>
    </div>
  `;
}

function renderSuccessStep(_model: any): string {
  return `
    <div class="wf-section">
      <h2 class="wf-section-title">Project Resolved <span class="wf-badge success">✓ Success</span></h2>
      <div class="wf-card">
        <p>All blocking issues have been resolved and verified.</p>
      </div>
      <div class="wf-btn-group">
        <button class="wf-btn primary" data-command="workflow.testProject">Test Project</button>
        <button class="wf-btn secondary" data-command="workflow.restart">Start Over</button>
      </div>
    </div>
  `;
}

function renderFailedStep(model: any): string {
  return `
    <div class="wf-section">
      <h2 class="wf-section-title">Resolution Failed <span class="wf-badge error">✗ Failed</span></h2>
      <div class="wf-error">
        <div class="wf-error-title">Unable to complete resolution</div>
        <div>${escapeHtml(model.errorMessage || 'An unknown error occurred')}</div>
      </div>
      <div class="wf-btn-group">
        <button class="wf-btn primary" data-command="workflow.returnToPlan">Return to Repair Plan</button>
        <button class="wf-btn secondary" data-command="workflow.reanalyze">Re-analyze</button>
        <button class="wf-btn secondary" data-command="workflow.restart">Start Over</button>
      </div>
    </div>
  `;
}

function escapeHtml(text: string): string {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#039;');
}