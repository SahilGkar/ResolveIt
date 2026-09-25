import * as vscode from 'vscode';
import type { Diagnostic } from '../../../src/index.js';
import {
  diagnosticDescription,
  diagnosticDetails,
  diagnosticLabel,
  severityGroup,
} from '../mappers.js';
import type { SeverityGroup } from '../mappers.js';
import type { ExtensionState } from '../state.js';

export type DiagnosticsNode =
  | { readonly kind: 'group'; readonly group: SeverityGroup }
  | { readonly kind: 'diagnostic'; readonly diagnostic: Diagnostic }
  | { readonly kind: 'detail'; readonly label: string; readonly filePath?: string };

const GROUP_ORDER: ReadonlyArray<SeverityGroup> = ['Critical', 'Errors', 'Warnings', 'Info'];

export class DiagnosticsTreeProvider implements vscode.TreeDataProvider<DiagnosticsNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData: vscode.Event<void> = this.emitter.event;

  constructor(
    private readonly state: ExtensionState,
    private readonly resolveFile?: (relativePath: string) => string
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: DiagnosticsNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const count = this.state.getDiagnostics().filter((d) => severityGroup(d.severity) === node.group).length;
      const item = new vscode.TreeItem(`${node.group} (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = 'resolveit-diagnostic-group';
      return item;
    }
    if (node.kind === 'diagnostic') {
      const item = new vscode.TreeItem(diagnosticLabel(node.diagnostic), vscode.TreeItemCollapsibleState.Collapsed);
      item.description = diagnosticDescription(node.diagnostic);
      item.tooltip = node.diagnostic.message;
      item.contextValue = 'resolveit-diagnostic';
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'resolveit-diagnostic-detail';
    if (node.filePath && this.resolveFile) {
      const absolute = this.resolveFile(node.filePath);
      item.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [vscode.Uri.file(absolute)],
      };
    }
    return item;
  }

  getChildren(node?: DiagnosticsNode): DiagnosticsNode[] {
    if (!node) {
      return GROUP_ORDER.filter((group) =>
        this.state.getDiagnostics().some((d) => severityGroup(d.severity) === group)
      ).map((group) => ({ kind: 'group', group }));
    }
    if (node.kind === 'group') {
      return this.state
        .getDiagnostics()
        .filter((d) => severityGroup(d.severity) === node.group)
        .map((diagnostic) => ({ kind: 'diagnostic', diagnostic }));
    }
    if (node.kind === 'diagnostic') {
      const details = diagnosticDetails(node.diagnostic);
      const files = node.diagnostic.affectedFiles ?? [];
      return details.map((label) => {
        const fileRef = files.find((file) => label.includes(file));
        if (fileRef) {
          return { kind: 'detail', label, filePath: fileRef };
        }
        return { kind: 'detail', label };
      });
    }
    return [];
  }
}
