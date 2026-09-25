import * as vscode from 'vscode';

export interface OutputChannelLike {
  appendLine(message: string): void;
  show(): void;
}

export function redactSecrets(line: string): string {
  return line
    .replace(/[A-Za-z0-9_.-]*api[_-]?key[A-Za-z0-9_.-]*\s*[:=]\s*['"]?\S+['"]?/gi, '[REDACTED_API_KEY]')
    .replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]');
}

export class Logger {
  private readonly channel: OutputChannelLike;

  constructor(channel?: OutputChannelLike) {
    this.channel = channel ?? vscode.window.createOutputChannel('ResolveIt');
  }

  info(message: string): void {
    this.channel.appendLine(redactSecrets(message));
  }

  warn(message: string): void {
    this.channel.appendLine(redactSecrets(`WARN: ${message}`));
  }

  error(message: string): void {
    this.channel.appendLine(redactSecrets(`ERROR: ${message}`));
  }

  show(): void {
    this.channel.show();
  }
}
