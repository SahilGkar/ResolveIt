import * as vscode from 'vscode';
import { resolveAIConfig } from '../../src/index.js';
import type { AIConfig } from '../../src/index.js';
import { CoreClient } from './core.js';
import { createCommandHandlers } from './commands.js';
import type { CommandContext } from './commands.js';
import { configToAIConfigOverrides, friendlyError } from './mappers.js';
import { ExtensionState } from './state.js';
import { vscodeApprovalDialogs } from './ui/approval.js';
import { Logger } from './ui/output.js';
import { createStatusBarItem, showOk } from './ui/statusBar.js';
import { DiagnosticsTreeProvider } from './views/diagnosticsTree.js';
import { EnvironmentTreeProvider } from './views/environmentTree.js';
import { ProjectTreeProvider } from './views/projectTree.js';
import { RequirementsTreeProvider } from './views/requirementsTree.js';

export const COMMAND_IDS = [
  'resolveit.scan',
  'resolveit.diagnose',
  'resolveit.run',
  'resolveit.environment',
  'resolveit.requirements',
  'resolveit.repair',
  'resolveit.verify',
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

  const projectTree = new ProjectTreeProvider(state);
  const diagnosticsTree = new DiagnosticsTreeProvider(state, (relative) => {
    const folders = vscode.workspace.workspaceFolders;
    const root = folders && folders.length > 0 && folders[0] ? folders[0].uri.fsPath : '';
    return root ? `${root}/${relative}` : relative;
  });
  const environmentTree = new EnvironmentTreeProvider(state);
  const requirementsTree = new RequirementsTreeProvider(state, (relative) => {
    const folders = vscode.workspace.workspaceFolders;
    const root = folders && folders.length > 0 && folders[0] ? folders[0].uri.fsPath : '';
    return root ? `${root}/${relative}` : relative;
  });

  const refreshViews = (): void => {
    projectTree.refresh();
    diagnosticsTree.refresh();
    environmentTree.refresh();
    requirementsTree.refresh();
  };

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
    getAIConfig: readAIConfig,
    getMaxIterations: readMaxIterations,
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

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('resolveit.project', projectTree),
    vscode.window.registerTreeDataProvider('resolveit.diagnostics', diagnosticsTree),
    vscode.window.registerTreeDataProvider('resolveit.environment', environmentTree),
    vscode.window.registerTreeDataProvider('resolveit.requirements', requirementsTree),
    statusItem
  );

  for (const id of COMMAND_IDS) {
    const handler = handlers[id];
    if (handler) {
      context.subscriptions.push(vscode.commands.registerCommand(id, () => handler()));
    }
  }

  void core
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

export function deactivate(): void {}
