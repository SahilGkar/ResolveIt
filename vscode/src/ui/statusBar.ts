import * as vscode from 'vscode';
import { statusTextForActivity, statusTextForIssues } from '../mappers.js';

export interface StatusBarItemLike {
  text: string;
  tooltip: string;
  command: string | undefined;
  show(): void;
  dispose(): void;
}

export function showIssues(item: StatusBarItemLike, total: number, blocking: number): void {
  item.text = statusTextForIssues(blocking);
  item.tooltip = total === 0 ? 'ResolveIt: no diagnostics' : `ResolveIt: ${total} diagnostics (${blocking} blocking)`;
  item.command = 'resolveit.diagnose';
  item.show();
}

export function showBusy(item: StatusBarItemLike, activity: string, tooltip: string): void {
  item.text = statusTextForActivity(activity);
  item.tooltip = tooltip;
  item.command = undefined;
  item.show();
}

export function showOk(item: StatusBarItemLike, tooltip: string): void {
  item.text = statusTextForIssues(0);
  item.tooltip = tooltip;
  item.command = 'resolveit.run';
  item.show();
}

export function createStatusBarItem(): StatusBarItemLike {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  return {
    get text(): string {
      return item.text;
    },
    set text(value: string) {
      item.text = value;
    },
    get tooltip(): string {
      return typeof item.tooltip === 'string' ? item.tooltip : '';
    },
    set tooltip(value: string) {
      item.tooltip = value;
    },
    get command(): string | undefined {
      return typeof item.command === 'string' ? item.command : undefined;
    },
    set command(value: string | undefined) {
      item.command = value as string;
    },
    show(): void {
      item.show();
    },
    dispose(): void {
      item.dispose();
    },
  };
}
