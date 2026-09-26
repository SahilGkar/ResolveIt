import * as vscode from 'vscode';
import { statusTextForIssues } from '../mappers.js';
import type { ExtensionState } from '../state.js';

export type ProjectNode =
  | { readonly kind: 'section'; readonly label: string }
  | { readonly kind: 'item'; readonly label: string; readonly description?: string; readonly commandId?: string };

export class ProjectTreeProvider implements vscode.TreeDataProvider<ProjectNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData: vscode.Event<void> = this.emitter.event;

  constructor(private readonly state: ExtensionState) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: ProjectNode): vscode.TreeItem {
    if (node.kind === 'section') {
      return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    if (node.description) {
      item.description = node.description;
    }
    if (node.commandId) {
      item.command = { command: node.commandId, title: node.label };
    }
    if (node.label.startsWith('Provider:') || node.label.startsWith('Status:') || node.label.startsWith('Model:')) {
      item.iconPath = new vscode.ThemeIcon('sparkle');
    }
    return item;
  }

  getChildren(node?: ProjectNode): ProjectNode[] {
    if (!node) {
      return [
        { kind: 'section', label: 'Project' },
        { kind: 'section', label: 'Status' },
        { kind: 'section', label: 'Actions' },
        { kind: 'section', label: 'AI' },
        { kind: 'section', label: 'Last Run' },
      ];
    }
    if (node.kind !== 'section') {
      return [];
    }
    switch (node.label) {
      case 'Project': {
        const name = this.state.getProjectName();
        if (!name) {
          return [{ kind: 'item', label: 'Not analyzed yet', description: 'Run Analyze Project', commandId: 'resolveit.analyzeProject' }];
        }
        return [{ kind: 'item', label: name }];
      }
      case 'Status': {
        if (!this.state.getHasScanned()) {
          return [{ kind: 'item', label: 'No analysis results yet', description: 'Analyze to check environment and requirements', commandId: 'resolveit.analyzeProject' }];
        }
        const total = this.state.getDiagnostics().length;
        const blocking = this.state.blockingCount();
        return [{ kind: 'item', label: statusTextForIssues(blocking), description: `${total} total` }];
      }
      case 'Actions':
        return [
          { kind: 'item', label: 'Analyze Project', commandId: 'resolveit.analyzeProject' },
          { kind: 'item', label: 'Generate Repair Plan', commandId: 'resolveit.generateRepairPlan' },
          { kind: 'item', label: 'Apply Approved Repairs', commandId: 'resolveit.applyApprovedRepairs' },
          { kind: 'item', label: 'Verify Project', commandId: 'resolveit.verify' },
        ];
      case 'AI': {
        const ai = this.state.getAIStatus();
        if (!ai) {
          return [{ kind: 'item', label: 'Provider: (unknown)', description: 'Configure in settings', commandId: 'resolveit.openSettings' }];
        }
        return [
          { kind: 'item', label: `Provider: ${ai.provider}` },
          { kind: 'item', label: `Model: ${ai.model}` },
          { kind: 'item', label: `Status: ${ai.available ? 'Available' : 'Unavailable'}` },
        ];
      }
      case 'Last Run': {
        const last = this.state.getLastRun();
        if (!last) {
          return [{ kind: 'item', label: 'No runs yet' }];
        }
        return [{ kind: 'item', label: last.status, description: last.summary }];
      }
      default:
        return [];
    }
  }
}
