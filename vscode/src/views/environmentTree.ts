import * as vscode from 'vscode';
import type { ExtensionState } from '../state.js';

export type EnvironmentNode =
  | { readonly kind: 'section'; readonly label: string }
  | { readonly kind: 'item'; readonly label: string; readonly description?: string };

export class EnvironmentTreeProvider implements vscode.TreeDataProvider<EnvironmentNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData: vscode.Event<void> = this.emitter.event;

  constructor(private readonly state: ExtensionState) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: EnvironmentNode): vscode.TreeItem {
    if (node.kind === 'section') {
      return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    if (node.description) {
      item.description = node.description;
    }
    return item;
  }

  getChildren(node?: EnvironmentNode): EnvironmentNode[] {
    const environment = this.state.getEnvironment();
    if (!environment) {
      if (!node) {
        return [{ kind: 'item', label: '(run ResolveIt: Show Environment)' }];
      }
      return [];
    }
    if (!node) {
      return [
        { kind: 'section', label: 'Runtimes' },
        { kind: 'section', label: 'Tools' },
        { kind: 'section', label: 'Package Managers' },
        { kind: 'section', label: 'Containers' },
      ];
    }
    if (node.kind !== 'section') {
      return [];
    }
    switch (node.label) {
      case 'Runtimes':
        return environment.runtimes.map((runtime) => ({
          kind: 'item',
          label: `${runtime.available ? '✓' : '✗'} ${runtime.name}`,
          description: runtime.version ?? 'unknown',
        }));
      case 'Tools':
        return environment.devTools.map((tool) => ({
          kind: 'item',
          label: `${tool.available ? '✓' : '✗'} ${tool.name}`,
          description: tool.version ?? 'unknown',
        }));
      case 'Package Managers':
        return environment.packageManagers.map((manager) => ({
          kind: 'item',
          label: `${manager.available ? '✓' : '✗'} ${manager.name}`,
          description: manager.version ?? 'unknown',
        }));
      case 'Containers':
        return [
          {
            kind: 'item',
            label: `Docker ${environment.containers.docker.available ? '✓' : '✗'}`,
            description: environment.containers.dockerRunning ? 'running' : 'not running',
          },
        ];
      default:
        return [];
    }
  }
}
