import * as vscode from 'vscode';
import { resolveAIConfig } from '../../src/index.js';
import type { AIConfig } from '../../src/index.js';
import { CoreClient } from './core.js';
import { createCommandHandlers } from './commands.js';
import type { CancellationTokenLike, CommandContext } from './commands.js';
import { configToAIConfigOverrides, friendlyError, multiRootNotice } from './mappers.js';
import { OperationCoordinator } from './operations.js';
import { ExtensionState } from './state.js';
import { WorkflowProvider } from './workflow/view.js';
import type { WorkflowStep } from './workflow/model.js';
import { vscodeApprovalDialogs } from './ui/approval.js';
import { Logger } from './ui/output.js';
import { createStatusBarItem, showOk } from './ui/statusBar.js';
import { WorkspaceService } from './workspace.js';

export const COMMAND_IDS = [
  'resolveit.scan',
  'resolveit.diagnose',
  'resolveit.run',
  'resolveit.environment',
  'resolveit.requirements',
  'resolveit.repair',
  'resolveit.verify',
  'resolveit.analyzeProject',
  'resolveit.generateRepairPlan',
  'resolveit.applyApprovedRepairs',
  'resolveit.approveAction',
  'resolveit.skipAction',
  'resolveit.reviewProblems',
  'resolveit.reviewRepairs',
  'resolveit.askAI',
  'resolveit.retryAI',
  'resolveit.showDetails',
  'resolveit.openSettings',
  'resolveit.openWorkflow',
] as const;

function readAIConfig(): AIConfig {
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

function readMaxIterations(): number {
  const settings = vscode.workspace.getConfiguration('resolveit');
  const value = settings.get('maxIterations', 3);
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return 3;
}

export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger();
  logger.info('ResolveIt extension activated.');

  const state = new ExtensionState();
  const core = new CoreClient();
  const statusItem = createStatusBarItem();
  showOk(statusItem, 'ResolveIt: ready');

  const workflow = new WorkflowProvider(context, state, logger, core);

  const refreshViews = (): void => {
    workflow.refresh();
  };

  const coordinator = new OperationCoordinator();
  const workspaces = new WorkspaceService({
    getFolders: () => vscode.workspace.workspaceFolders ?? [],
    notifyMultiRoot: (roots) => {
      void vscode.window.showWarningMessage(multiRootNotice(roots));
    },
    onWorkspaceChanged: (root) => {
      state.bindWorkspace(root);
      showOk(statusItem, root ? `ResolveIt: watching ${root}` : 'ResolveIt: no workspace open');
      refreshViews();
      logger.info(root ? `Workspace changed; now watching ${root}. Previous state cleared.` : 'Workspace closed; state cleared.');
    },
  });

  const statusControls = {
    showBusy: (activity: string, tooltip: string): void => {
      statusItem.text = `$(sync~spin) ResolveIt: ${activity}`;
      statusItem.tooltip = tooltip;
      statusItem.command = undefined;
      statusItem.show();
    },
    showIssues: (total: number, blocking: number): void => {
      statusItem.text = blocking === 0 ? '$(check) ResolveIt' : `$(warning) ResolveIt: ${blocking} issue${blocking === 1 ? '' : 's'}`;
      statusItem.tooltip = `${total} diagnostics (${blocking} blocking)`;
      statusItem.command = 'resolveit.diagnose';
      statusItem.show();
    },
    showOk: (tooltip: string): void => {
      showOk(statusItem, tooltip);
    },
  };

  const commandContext: CommandContext = {
    core,
    state,
    logger,
    messages: {
      info: (message: string) => {
        void vscode.window.showInformationMessage(message);
      },
      warn: (message: string) => {
        void vscode.window.showWarningMessage(message);
      },
      error: (message: string) => {
        void vscode.window.showErrorMessage(message);
      },
    },
    status: statusControls,
    dialogs: vscodeApprovalDialogs(),
    coordinator,
    workspaces,
    refreshViews,
    getWorkspaceFolders: () => vscode.workspace.workspaceFolders ?? [],
    reportProgress: <T,>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> => {
      return Promise.resolve(
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title, cancellable: false },
          async (progress) => task((message: string) => progress.report({ message }))
        )
      );
    },
    reportCancellable: <T,>(
      title: string,
      task: (report: (message: string) => void, token: CancellationTokenLike) => Promise<T>
    ): Promise<T> => {
      return Promise.resolve(
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title, cancellable: true },
          async (progress, token) => task((message: string) => progress.report({ message }), token)
        )
      );
    },
    getAIConfig: readAIConfig,
    getMaxIterations: readMaxIterations,
    openWorkflow: (step?: WorkflowStep): void => {
      workflow.show();
      if (step) {
        workflow.goToStep(step);
      }
    },
    openSettings: (query: string): void => {
      void vscode.commands.executeCommand('workbench.action.openSettings', query);
    },
    showOutput: (): void => {
      logger.show();
    },
    openFile: async (absolutePath: string): Promise<void> => {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
        await vscode.window.showTextDocument(document);
      } catch (error) {
        logger.error(friendlyError(`Could not open ${absolutePath}`, error));
      }
    },
  };

  const handlers = createCommandHandlers(commandContext);

  handlers['resolveit.openWorkflow'] = async (): Promise<void> => {
    workflow.show();
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      workspaces.sync();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('resolveit')) {
        logger.info('ResolveIt configuration changed; refreshing AI status.');
        void refreshAIStatus();
      }
    }),
    statusItem
  );

  for (const id of COMMAND_IDS) {
    const handler = handlers[id];
    if (handler) {
      context.subscriptions.push(vscode.commands.registerCommand(id, (...args: unknown[]) => handler(...args)));
    }
  }

  function refreshAIStatus(): Promise<void> {
    return core
      .aiStatus(readAIConfig())
      .then((status) => {
        state.setAIStatus({ provider: status.provider, model: status.model, baseUrl: status.baseUrl, available: status.available });
        refreshViews();
        logger.info(`AI provider: ${status.provider} (${status.available ? 'available' : 'unavailable'}).`);
      })
      .catch((error: unknown) => {
        logger.error(friendlyError('Could not determine AI provider status', error));
      });
  }

  void refreshAIStatus();
}

export function deactivate(): void {}
