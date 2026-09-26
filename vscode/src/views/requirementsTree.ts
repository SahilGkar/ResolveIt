import * as vscode from 'vscode';
import type { ProjectRequirement } from '../../../src/index.js';
import type { ExtensionState } from '../state.js';

export type RequirementsNode =
  | { readonly kind: 'section'; readonly label: string }
  | { readonly kind: 'item'; readonly requirement: ProjectRequirement };

const SECTION_FOR_TYPE: ReadonlyArray<{ section: string; types: ReadonlyArray<string> }> = [
  { section: 'Runtime Requirements', types: ['runtime-version', 'language-version'] },
  { section: 'Dependencies', types: ['package-dependency'] },
  { section: 'Development Dependencies', types: [] },
  { section: 'Build Tools', types: ['build-tool', 'toolchain', 'package-manager', 'system-tool'] },
  { section: 'Containers', types: ['container-image'] },
];

export function sectionForRequirement(requirement: ProjectRequirement): string {
  if (requirement.developmentOnly === true && requirement.type === 'package-dependency') {
    return 'Development Dependencies';
  }
  for (const entry of SECTION_FOR_TYPE) {
    if (entry.types.includes(requirement.type)) {
      return entry.section;
    }
  }
  return 'Other';
}

export class RequirementsTreeProvider implements vscode.TreeDataProvider<RequirementsNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData: vscode.Event<void> = this.emitter.event;

  constructor(
    private readonly state: ExtensionState,
    private readonly resolveFile?: (relativePath: string) => string
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: RequirementsNode): vscode.TreeItem {
    if (node.kind === 'section') {
      return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
    }
    const label = node.requirement.versionConstraint
      ? `${node.requirement.name} ${node.requirement.versionConstraint}`
      : node.requirement.name;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = node.requirement.sourceFile;
    item.tooltip = `${node.requirement.ecosystem} · ${node.requirement.type}`;
    if (this.resolveFile) {
      item.command = {
        command: 'vscode.open',
        title: 'Open Source File',
        arguments: [vscode.Uri.file(this.resolveFile(node.requirement.sourceFile))],
      };
    }
    return item;
  }

  getChildren(node?: RequirementsNode): RequirementsNode[] {
    const all = this.state.getRequirements().flatMap((parsed) => [...parsed.requirements]);
    if (all.length === 0 && !node) {
      return [{ kind: 'section', label: 'No project requirements detected' }];
    }
    if (!node) {
      const sections: string[] = [];
      for (const requirement of all) {
        const section = sectionForRequirement(requirement);
        if (!sections.includes(section)) {
          sections.push(section);
        }
      }
      return sections.map((label) => ({ kind: 'section', label }));
    }
    if (node.kind !== 'section') {
      return [];
    }
    return all
      .filter((requirement) => sectionForRequirement(requirement) === node.label)
      .map((requirement) => ({ kind: 'item', requirement }));
  }
}
