import * as vscode from 'vscode';

export interface OutputChannelLike {
  appendLine(message: string): void;
  show(): void;
}

export function redactSecrets(line: string): string {
  return line
    .replace(/[A-Za-z0-9_.-]*api[_-]?key[A-Za-z0-9_.-]*\s*[:=]\s*['"]?\S+['"]?/gi, '[REDACTED_API_KEY]')
    .replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]')
    .replace(/Basic\s+[A-Za-z0-9+/=]{8,}/g, 'Basic [REDACTED]')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
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
