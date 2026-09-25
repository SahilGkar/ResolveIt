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
      case 'Project':
        return [{ kind: 'item', label: this.state.getProjectName() ?? '(not scanned)' }];
      case 'Status': {
        const total = this.state.getDiagnostics().length;
        const blocking = this.state.blockingCount();
        return [{ kind: 'item', label: statusTextForIssues(blocking), description: `${total} total` }];
      }
      case 'Actions':
        return [
          { kind: 'item', label: 'Scan', commandId: 'resolveit.scan' },
          { kind: 'item', label: 'Diagnose', commandId: 'resolveit.diagnose' },
          { kind: 'item', label: 'Run ResolveIt', commandId: 'resolveit.run' },
        ];
      case 'AI': {
        const ai = this.state.getAIStatus();
        if (!ai) {
          return [{ kind: 'item', label: 'Provider: (unknown)' }];
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
