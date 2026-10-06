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

export interface WebviewPanelStub {
  readonly viewType: string;
  readonly title: string;
  readonly viewColumn: unknown;
  readonly options: { enableScripts: boolean; retainContextWhenHidden: boolean; localResourceRoots: unknown };
  disposed: boolean;
  revealed: number;
  readonly posted: unknown[];
  readonly webview: {
    options: Record<string, unknown>;
    /** Mirrors the real API: HTML is assigned on the webview, not the panel. */
    html: string;
    cspSource: string;
    postMessage(message: unknown): Promise<boolean>;
    asWebviewUri(uri: Uri): Uri;
    onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void };
  };
  reveal(column?: unknown): void;
  onDidDispose(listener: () => void, _thisArg?: unknown, disposables?: Array<{ dispose(): void }>): { dispose(): void };
  dispose(): void;
}

class WebviewPanelStub implements WebviewPanelStub {
  public disposed = false;
  public revealed = 0;
  public readonly posted: unknown[] = [];
  private readonly messageListeners: Array<(message: unknown) => void> = [];
  private readonly disposeListeners: Array<() => void> = [];
  private readonly webviewBox: WebviewPanelStub['webview'];

  constructor(
    public readonly viewType: string,
    public readonly title: string,
    public readonly viewColumn: unknown,
    public readonly options: { enableScripts: boolean; retainContextWhenHidden: boolean; localResourceRoots: unknown }
  ) {
    this.webviewBox = {
      options: {},
      html: '',
      cspSource: `vscode-webview://mock/${viewType}`,
      postMessage: (message: unknown): Promise<boolean> => {
        this.posted.push(message);
        return Promise.resolve(true);
      },
      asWebviewUri: (uri: Uri): Uri => uri,
      onDidReceiveMessage: (listener: (message: unknown) => void) => {
        this.messageListeners.push(listener);
        return { dispose: () => undefined };
      },
    };
  }

  get webview(): WebviewPanelStub['webview'] {
    return this.webviewBox;
  }

  /** Test helper: simulate the webview script running and posting a message. */
  emit(message: unknown): void {
    for (const listener of [...this.messageListeners]) {
      listener(message);
    }
  }

  reveal(): void {
    this.revealed += 1;
  }

  onDidDispose(listener: () => void, _thisArg?: unknown, disposables?: Array<{ dispose(): void }>): { dispose(): void } {
    this.disposeListeners.push(listener);
    const subscription = { dispose: () => undefined };
    if (Array.isArray(disposables)) {
      disposables.push(subscription);
    }
    return subscription;
  }

  dispose(): void {
    this.disposed = true;
    for (const listener of [...this.disposeListeners]) {
      listener();
    }
  }
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
  webviewPanels: WebviewPanelStub[];
  configurationUpdates: Array<{ key: string; value: unknown }>;
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
  webviewPanels: [],
  configurationUpdates: [],
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
  __testState.webviewPanels = [];
  __testState.configurationUpdates = [];
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
  registerWebviewViewProvider(viewId: string, _provider: unknown): { dispose(): void } {
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
  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions: unknown,
    options?: { enableScripts?: boolean; retainContextWhenHidden?: boolean; localResourceRoots?: unknown }
  ): WebviewPanelStub {
    const panel = new WebviewPanelStub(viewType, title, showOptions, {
      enableScripts: options?.enableScripts ?? false,
      retainContextWhenHidden: options?.retainContextWhenHidden ?? false,
      localResourceRoots: options?.localResourceRoots ?? [],
    });
    __testState.webviewPanels.push(panel);
    return panel;
  },
};

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export const workspace = {
  get workspaceFolders(): TestState['workspaceFolders'] | undefined {
    return __testState.workspaceFolders.length > 0 ? __testState.workspaceFolders : undefined;
  },
  getConfiguration(_section: string): {
    get<T>(key: string, defaultValue?: T): T | undefined;
    update(key: string, value: unknown, target?: unknown): Promise<void>;
  } {
    return {
      get: <T,>(key: string, defaultValue?: T): T | undefined => {
        const value = __testState.config[key] as T | undefined;
        return value ?? defaultValue;
      },
      update: (key: string, value: unknown, _target?: unknown): Promise<void> => {
        __testState.configurationUpdates.push({ key, value });
        __testState.config[key] = value;
        return Promise.resolve();
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
