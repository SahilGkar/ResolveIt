export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  public description?: string | undefined;
  public tooltip?: string | undefined;
  public command?: { command: string; title: string; arguments?: unknown[] } | undefined;
  public contextValue?: string | undefined;

  constructor(
    public readonly label: string,
    public readonly collapsibleState: TreeItemCollapsibleState
  ) {}
}

export class EventEmitter {
  public readonly event: unknown = () => undefined;

  fire(): void {}

  dispose(): void {}
}

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ProgressLocation {
  Notification = 15,
  Window = 10,
}

export class Uri {
  private constructor(public readonly fsPath: string) {}

  static file(path: string): Uri {
    return new Uri(path);
  }

  static parse(path: string): Uri {
    return new Uri(path);
  }
}

export interface MessageRecord {
  readonly kind: 'info' | 'warn' | 'error';
  readonly message: string;
}

interface TestState {
  messages: MessageRecord[];
  quickPickAnswers: Array<string | undefined>;
  registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  registeredViews: string[];
  progressReports: string[];
  openedFiles: string[];
  outputLines: string[];
  config: Record<string, unknown>;
  workspaceFolders: Array<{ name: string; uri: Uri; index: number }>;
  statusBarItems: StatusBarItemStub[];
  workspaceFolderListeners: Array<() => void>;
  configChangeListeners: Array<(event: { affectsConfiguration(section: string): boolean }) => void>;
  progressTokens: Array<{ cancel(): void }>;
}

class StatusBarItemStub {
  public text = '';
  public tooltip: string | undefined = '';
  public command: string | undefined = undefined;
  public shown = false;
  public disposed = false;

  show(): void {
    this.shown = true;
  }

  dispose(): void {
    this.disposed = true;
  }
}

export const __testState: TestState = {
  messages: [],
  quickPickAnswers: [],
  registeredCommands: new Map(),
  registeredViews: [],
  progressReports: [],
  openedFiles: [],
  outputLines: [],
  config: {},
  workspaceFolders: [],
  statusBarItems: [],
  workspaceFolderListeners: [],
  configChangeListeners: [],
  progressTokens: [],
};

export function __reset(): void {
  __testState.messages = [];
  __testState.quickPickAnswers = [];
  __testState.registeredCommands = new Map();
  __testState.registeredViews = [];
  __testState.progressReports = [];
  __testState.openedFiles = [];
  __testState.outputLines = [];
  __testState.config = {};
  __testState.workspaceFolders = [];
  __testState.statusBarItems = [];
  __testState.workspaceFolderListeners = [];
  __testState.configChangeListeners = [];
  __testState.progressTokens = [];
}

export const commands = {
  registerCommand(id: string, callback: (...args: unknown[]) => unknown): { dispose(): void } {
    __testState.registeredCommands.set(id, callback);
    return { dispose: () => undefined };
  },
};

export const window = {
  showInformationMessage(message: string): Promise<undefined> {
    __testState.messages.push({ kind: 'info', message });
    return Promise.resolve(undefined);
  },
  showWarningMessage(message: string): Promise<undefined> {
    __testState.messages.push({ kind: 'warn', message });
    return Promise.resolve(undefined);
  },
  showErrorMessage(message: string): Promise<undefined> {
    __testState.messages.push({ kind: 'error', message });
    return Promise.resolve(undefined);
  },
  showQuickPick(items: string[], _options?: unknown): Promise<string | undefined> {
    const next = __testState.quickPickAnswers.shift();
    if (next === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(items.includes(next) ? next : undefined);
  },
  withProgress(
    _options: unknown,
    task: (
      progress: { report(value: { message: string }): void },
      token: { isCancellationRequested: boolean; onCancellationRequested(callback: () => void): void }
    ) => Promise<unknown>
  ): Promise<unknown> {
    const listeners: Array<() => void> = [];
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (callback: () => void): void => {
        listeners.push(callback);
      },
    };
    __testState.progressTokens.push({
      cancel: () => {
        (token as { isCancellationRequested: boolean }).isCancellationRequested = true;
        for (const listener of listeners) {
          listener();
        }
      },
    });
    return task({ report: (value) => __testState.progressReports.push(value.message) }, token);
  },
  registerTreeDataProvider(viewId: string, _provider: unknown): { dispose(): void } {
    __testState.registeredViews.push(viewId);
    return { dispose: () => undefined };
  },
  createOutputChannel(_name: string): { appendLine(message: string): void; show(): void } {
    return {
      appendLine: (message: string) => __testState.outputLines.push(message),
      show: () => undefined,
    };
  },
  createStatusBarItem(_alignment: StatusBarAlignment, _priority: number): StatusBarItemStub {
    const item = new StatusBarItemStub();
    __testState.statusBarItems.push(item);
    return item;
  },
  showTextDocument(document: { uri: Uri }): Promise<void> {
    __testState.openedFiles.push(document.uri.fsPath);
    return Promise.resolve();
  },
};

export const workspace = {
  get workspaceFolders(): TestState['workspaceFolders'] | undefined {
    return __testState.workspaceFolders.length > 0 ? __testState.workspaceFolders : undefined;
  },
  getConfiguration(_section: string): { get<T>(key: string, defaultValue?: T): T | undefined } {
    return {
      get: <T,>(key: string, defaultValue?: T): T | undefined => {
        const value = __testState.config[key] as T | undefined;
        return value ?? defaultValue;
      },
    };
  },
  openTextDocument(path: string): Promise<{ uri: Uri }> {
    return Promise.resolve({ uri: Uri.file(path) });
  },
  onDidChangeWorkspaceFolders(listener: () => void): { dispose(): void } {
    __testState.workspaceFolderListeners.push(listener);
    return { dispose: () => undefined };
  },
  onDidChangeConfiguration(
    listener: (event: { affectsConfiguration(section: string): boolean }) => void
  ): { dispose(): void } {
    __testState.configChangeListeners.push(listener);
    return { dispose: () => undefined };
  },
};
