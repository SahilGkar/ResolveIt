import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { __reset, __testState } from './vscode-mock.js';
import { ExtensionState } from '../src/state.js';
import { Logger } from '../src/ui/output.js';
import { CoreClient } from '../src/core.js';
import { createWorkflowCommandHandlers, type WorkflowCommandContext } from '../src/workflow/commands.js';
import { buildWorkflowModel, resolveActionLifecycle } from '../src/workflow/model.js';
import { renderWorkflowHtml } from '../src/workflow/render.js';
import { validateWorkflowMessage, WORKFLOW_ALLOWED_COMMANDS } from '../src/workflow/messages.js';
import type { RepairAction, RepairPlan, RepairResult, Diagnostic } from '../../src/index.js';

beforeEach(() => {
  __reset();
});

function makeAction(id: string, description = `Install ${id}`): RepairAction {
  return {
    id,
    type: 'install-dependency',
    permissionLevel: 'project-modification',
    description,
    target: { filePath: 'package.json' },
    parameters: { ecosystem: 'npm', package: id },
    affectedFiles: ['package.json'],
    riskLevel: 'project-modification',
    prerequisites: [],
  };
}

function makePlan(count: number): RepairPlan {
  return {
    id: 'plan-1',
    name: 'plan',
    description: 'plan',
    actions: Array.from({ length: count }, (_, i) => makeAction(`a${i + 1}`)),
    requiresApproval: true,
  };
}

function handlersFor(
  state: ExtensionState,
  core: unknown,
  aiProvider: 'none' | 'local' | 'external' = 'none'
): { handlers: ReturnType<typeof createWorkflowCommandHandlers>; info: string[]; warnings: string[] } {
  const info: string[] = [];
  const warnings: string[] = [];
  const ctx: WorkflowCommandContext = {
    state,
    logger: new Logger({ appendLine: () => undefined, show: () => undefined }),
    core: core as unknown as CoreClient,
    showMessage: (m) => info.push(m),
    showWarning: (m) => warnings.push(m),
    showError: () => undefined,
    showProgress: (_t, task) => task(() => undefined),
    showCancellableProgress: (_t, task) =>
      task(() => undefined, { isCancellationRequested: false, onCancellationRequested: () => undefined }),
    getAIConfig: () => ({ provider: aiProvider }),
    getMaxIterations: () => 3,
    getWorkspaceRoot: () => 'C:\\ws',
    openFile: () => Promise.resolve(),
    postMessage: () => undefined,
  };
  return { handlers: createWorkflowCommandHandlers(ctx), info, warnings };
}

function smartPlan(options: {
  aiUsed: boolean;
  rejections?: string[];
  fallback?: string;
  manual?: string[];
}): {
  plan: RepairPlan;
  diagnostics: never[];
  aiUsed: boolean;
  aiRejections: string[];
  fallbackReason?: string;
  manualActions: Array<{ description: string }>;
} {
  return {
    plan: makePlan(2),
    diagnostics: [],
    aiUsed: options.aiUsed,
    aiRejections: options.rejections ?? [],
    ...(options.fallback === undefined ? {} : { fallbackReason: options.fallback }),
    manualActions: (options.manual ?? []).map((description) => ({ description })),
  };
}

describe('AI mode selection', () => {
  it('should render the selected provider, model, and connection status', () => {
    const state = new ExtensionState();
    state.setAIStatus({ provider: 'local', model: 'qwen', baseUrl: 'http://localhost:11434', available: true });
    const model = buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: '/ws',
      requestedStep: 'ai-mode',
    });
    const html = renderWorkflowHtml(model);
    expect(html).toContain('How should ResolveIt reason?');
    expect(html).toContain('qwen');
    expect(html).toContain('reachable');
    expect(html).toContain('data-command="workflow.setAiMode"');
    expect(html).toContain('data-command="workflow.retryAi"');
    expect(html).not.toContain('sk-');
  });

  it('should report an unreachable provider instead of pretending it works', () => {
    const state = new ExtensionState();
    state.setAIStatus({ provider: 'external', model: 'gpt-x', baseUrl: 'https://example.invalid', available: false });
    const html = renderWorkflowHtml(
      buildWorkflowModel(state, {
        hasWorkspace: true,
        workspaceName: 'ws',
        workspaceRoot: '/ws',
        requestedStep: 'ai-mode',
      })
    );
    expect(html).toContain('unreachable');
  });

  it('should write the selected mode to configuration', async () => {
    const state = new ExtensionState();
    const { handlers } = handlersFor(state, {});
    await handlers['workflow.setAiMode']?.(undefined, 'local');
    expect(__testState.configurationUpdates).toContainEqual({ key: 'ai.provider', value: 'local' });
    expect(__testState.config['ai.provider']).toBe('local');
  });

  it('should ignore an unknown AI mode instead of writing it', async () => {
    const state = new ExtensionState();
    const { handlers } = handlersFor(state, {});
    await handlers['workflow.setAiMode']?.(undefined, 'skynet');
    expect(__testState.configurationUpdates).toEqual([]);
  });

  it('should refresh the AI connection status on demand', async () => {
    const state = new ExtensionState();
    const core = {
      aiStatus: async () => ({
        provider: 'local',
        name: 'Local AI Provider',
        model: 'qwen',
        baseUrl: 'http://localhost:11434',
        apiKeyConfigured: false,
        available: true,
      }),
    };
    const { handlers, info } = handlersFor(state, core);
    await handlers['workflow.retryAi']?.();
    expect(state.getAIStatus()?.available).toBe(true);
    expect(info.join(' ')).toContain('AI available');
  });
});

describe('repair plan provenance is truthful', () => {
  function scannedState(): ExtensionState {
    const state = new ExtensionState();
    state.bindWorkspace('C:\\ws');
    state.setProjectName('demo');
    state.markScanned();
    state.setDiagnostics([]);
    return state;
  }

  it('should label a deterministic plan as deterministic, never as AI', async () => {
    const state = scannedState();
    const core = { planRepairsSmart: async () => smartPlan({ aiUsed: false }) };
    const { handlers } = handlersFor(state, core, 'none');
    await handlers['workflow.generatePlan']?.();
    expect(state.getRepairPlanAiUsed()).toBe(false);
    const html = renderWorkflowHtml(
      buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: 'C:\\ws' })
    );
    expect(html).toContain('Deterministic repair plan');
    expect(html).not.toContain('AI-generated plan');
  });

  it('should label an AI-produced plan as AI-generated', async () => {
    const state = scannedState();
    const core = { planRepairsSmart: async () => smartPlan({ aiUsed: true }) };
    const { handlers } = handlersFor(state, core, 'local');
    await handlers['workflow.generatePlan']?.();
    expect(state.getRepairPlanAiUsed()).toBe(true);
    const html = renderWorkflowHtml(
      buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: 'C:\\ws' })
    );
    expect(html).toContain('AI-generated plan');
    expect(html).not.toContain('Deterministic repair plan');
  });

  it('should surface Core rejections and fallbacks instead of hiding them', async () => {
    const state = scannedState();
    const core = {
      planRepairsSmart: async () =>
        smartPlan({
          aiUsed: false,
          rejections: ['unknown action type: delete-everything'],
          fallback: 'AI planning failed',
          manual: ['Upgrade node by hand'],
        }),
    };
    const { handlers, warnings } = handlersFor(state, core, 'local');
    await handlers['workflow.generatePlan']?.();
    expect(warnings.join(' ')).toContain('fell back to deterministic planning');
    const notices = state.getRepairPlanNotices();
    expect(notices.join(' ')).toContain('unknown action type: delete-everything');
    expect(notices.join(' ')).toContain('Manual action required');
    const html = renderWorkflowHtml(
      buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: 'C:\\ws' })
    );
    expect(html).toContain('rejected by Core validation');
  });

  it('should fall back to deterministic planning when the AI endpoint is unreachable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resolveit-ai-fallback-'));
    try {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '1.0.0' }),
        'utf-8'
      );
      const core = new CoreClient();
      const result = await core.planRepairsSmart(
        root,
        { provider: 'local', model: 'unreachable-model', baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 },
        30000
      );
      expect(result.plan).toBeDefined();
      expect(result.aiUsed).toBe(false);
      expect(result.fallbackReason).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);
});

describe('per-action verification is honest', () => {
  function verifiedState(): ExtensionState {
    const state = new ExtensionState();
    state.setRepairPlan(makePlan(2), 'plan', false);
    state.setApproval('a1', true);
    state.setApproval('a2', true);
    state.setExecution({
      results: [
        { action: makeAction('a1'), result: { success: true } as RepairResult },
        { action: makeAction('a2'), result: { success: true } as RepairResult },
      ],
      success: true,
      timestamp: new Date(),
    });
    return state;
  }

  it('should mark executed actions verified only after verification passes', () => {
    const state = verifiedState();
    state.setLastVerification({ resolved: ['k1'], remaining: [], timestamp: new Date() });
    const model = buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: '/ws' });
    expect(model.repairPlan.actions.map((a) => a.lifecycle)).toEqual(['verified', 'verified']);
  });

  it('should keep executed actions at executed when verification fails', () => {
    const state = verifiedState();
    state.setLastVerification({ resolved: ['k1'], remaining: ['k2'], timestamp: new Date() });
    const model = buildWorkflowModel(state, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: '/ws' });
    expect(model.repairPlan.actions.map((a) => a.lifecycle)).toEqual(['executed', 'executed']);
    expect(resolveActionLifecycle('approved', { success: true }, false)).toBe('executed');
  });

  it('should never resolve a failed action to approved', () => {
    expect(resolveActionLifecycle('approved', { success: false, error: 'npm exploded' }, false)).toBe('failed');
    expect(resolveActionLifecycle('denied', undefined, false)).toBe('denied');
    expect(resolveActionLifecycle('awaiting', undefined, false)).toBe('awaiting-approval');
  });
});

describe('workflow message validation', () => {
  it('should accept known workflow commands with well-formed ids', () => {
    expect(validateWorkflowMessage({ type: 'command', command: 'workflow.analyze' })).toEqual({
      command: 'workflow.analyze',
    });
    expect(
      validateWorkflowMessage({ type: 'command', command: 'workflow.toggleApproval', actionId: 'action-1' })
    ).toEqual({ command: 'workflow.toggleApproval', actionId: 'action-1' });
    expect(validateWorkflowMessage({ type: 'command', command: 'workflow.setAiMode', step: 'local' })).toEqual({
      command: 'workflow.setAiMode',
      step: 'local',
    });
  });

  it('should reject legacy and foreign commands (dead command detection)', () => {
    for (const command of [
      'resolveit.analyzeProject',
      'resolveit.approveAction',
      'resolveit.diagnose',
      'workbench.action.openSettings',
      'vscode.open',
      'workflow.destroyEverything',
      // Removed from the simplified workflow: must never route again.
      'workflow.testProject',
      'workflow.smokeTest',
      'workflow.goBack',
      'workflow.goForward',
    ]) {
      expect(
        validateWorkflowMessage({ type: 'command', command }),
        `${command} must not be routable from the panel`
      ).toBeUndefined();
      expect(WORKFLOW_ALLOWED_COMMANDS.has(command)).toBe(false);
    }
  });

  it('should reject hostile or malformed payloads', () => {
    expect(validateWorkflowMessage(undefined)).toBeUndefined();
    expect(validateWorkflowMessage({ type: 'render', html: 'x' })).toBeUndefined();
    expect(validateWorkflowMessage({ type: 'command', command: 'workflow.toggleApproval' })).toBeUndefined();
    expect(
      validateWorkflowMessage({ type: 'command', command: 'workflow.toggleApproval', actionId: '../../x; rm -rf' })
    ).toBeUndefined();
    expect(validateWorkflowMessage({ type: 'command', command: 'workflow.setAiMode', step: 'skynet' })).toBeUndefined();
    expect(validateWorkflowMessage({ type: 'command', command: 'workflow.setAiMode' })).toBeUndefined();
  });
});

describe('success and failure screens carry evidence', () => {
  function resolvedState(): ExtensionState {
    const state = new ExtensionState();
    state.bindWorkspace('/ws');
    state.markScanned();
    state.setDiagnostics([] as Diagnostic[]);
    state.setRepairPlan(makePlan(1), 'plan', false);
    state.setApproval('a1', true);
    state.setExecution({
      results: [{ action: makeAction('a1'), result: { success: true } as RepairResult }],
      success: true,
      timestamp: new Date(),
    });
    state.setLastVerification({ resolved: ['k1'], remaining: [], timestamp: new Date() });
    state.markWorkflowCompleted();
    return state;
  }

  it('should show repairs and verification evidence on success', () => {
    const html = renderWorkflowHtml(
      buildWorkflowModel(resolvedState(), { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: '/ws' })
    );
    expect(html).toContain('Done');
    expect(html).toContain('Fixes applied');
    expect(html).toContain('Final check passed');
    expect(html).toContain('data-command="workflow.restart"');
    expect(html).not.toContain('data-command="workflow.testProject"');
    expect(html).not.toContain('data-command="workflow.smokeTest"');
  });

  it('should distinguish execution and verification failures', () => {
    const failedExecution = resolvedState();
    failedExecution.clearWorkflowCompleted();
    failedExecution.setExecution({
      results: [{ action: makeAction('a1'), result: { success: false, error: 'npm exploded' } as RepairResult }],
      success: false,
      timestamp: new Date(),
    });
    failedExecution.setLastVerification({ resolved: [], remaining: ['k1'], timestamp: new Date() });
    failedExecution.setLastError('ResolveIt could not complete the repair. Reason: npm exploded');
    const html = renderWorkflowHtml(
      buildWorkflowModel(failedExecution, { hasWorkspace: true, workspaceName: 'ws', workspaceRoot: '/ws' })
    );
    expect(html).toContain('Problems Remain');
    expect(html).toContain('npm exploded');
    expect(html).toContain('data-command="workflow.returnToPlan"');
  });
});

describe('AI availability reflects probing, not selection', () => {
  function aiModeModel(): ReturnType<typeof buildWorkflowModel> {
    const state = new ExtensionState();
    return buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: '/ws',
      requestedStep: 'ai-mode',
    });
  }

  function localOption(model: ReturnType<typeof buildWorkflowModel>) {
    const option = model.aiModeOptions.find((entry) => entry.id === 'local');
    expect(option).toBeDefined();
    return option!;
  }

  it('should report not-checked when a mode is selected but never probed', () => {
    __testState.config['ai.provider'] = 'local';
    const model = aiModeModel();
    expect(localOption(model).status).toBe('not-checked');
    expect(localOption(model).available).toBe(false);
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Not checked');
  });

  it('should report connected only after a successful probe', () => {
    __testState.config['ai.provider'] = 'local';
    const state = new ExtensionState();
    state.setAIStatus({ provider: 'local', model: 'qwen', baseUrl: 'http://localhost:11434', available: true });
    const model = buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: '/ws',
      requestedStep: 'ai-mode',
    });
    expect(localOption(model).status).toBe('connected');
    expect(localOption(model).available).toBe(true);
    expect(renderWorkflowHtml(model)).toContain('Connected');
  });

  it('should report not-reachable when the probe failed despite selection', () => {
    __testState.config['ai.provider'] = 'local';
    const state = new ExtensionState();
    state.setAIStatus({ provider: 'local', model: 'qwen', baseUrl: 'http://localhost:11434', available: false });
    const model = buildWorkflowModel(state, {
      hasWorkspace: true,
      workspaceName: 'ws',
      workspaceRoot: '/ws',
      requestedStep: 'ai-mode',
    });
    expect(localOption(model).status).toBe('not-reachable');
    expect(localOption(model).available).toBe(false);
    const html = renderWorkflowHtml(model);
    expect(html).toContain('Not reachable');
    expect(html).toContain('unreachable');
  });

  it('should keep deterministic mode always available', () => {
    const model = aiModeModel();
    const none = model.aiModeOptions.find((entry) => entry.id === 'none');
    expect(none?.status).toBe('connected');
    expect(none?.available).toBe(true);
  });
});
