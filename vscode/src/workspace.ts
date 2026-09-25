export interface FolderLike {
  readonly name: string;
  readonly uri: { readonly fsPath: string };
}

export type WorkspaceResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'single'; readonly root: string }
  | { readonly kind: 'multi'; readonly roots: ReadonlyArray<string> };

export function resolveWorkspace(
  folders: ReadonlyArray<FolderLike> | undefined
): WorkspaceResolution {
  if (!folders || folders.length === 0) {
    return { kind: 'none' };
  }
  if (folders.length === 1 && folders[0]) {
    return { kind: 'single', root: folders[0].uri.fsPath };
  }
  return { kind: 'multi', roots: folders.map((folder) => folder.uri.fsPath) };
}

export function primaryRoot(resolution: WorkspaceResolution): string | undefined {
  if (resolution.kind === 'single') {
    return resolution.root;
  }
  if (resolution.kind === 'multi') {
    return resolution.roots[0];
  }
  return undefined;
}

export function workspaceSignature(folders: ReadonlyArray<FolderLike> | undefined): string {
  if (!folders || folders.length === 0) {
    return 'none';
  }
  return folders.map((folder) => folder.uri.fsPath).sort().join('|');
}

export interface WorkspaceServiceOptions {
  readonly getFolders: () => ReadonlyArray<FolderLike> | undefined;
  readonly notifyMultiRoot: (roots: ReadonlyArray<string>) => void;
  readonly onWorkspaceChanged?: (root: string | undefined) => void;
}

export class WorkspaceService {
  private lastSignature?: string;

  constructor(private readonly options: WorkspaceServiceOptions) {}

  current(): WorkspaceResolution {
    return resolveWorkspace(this.options.getFolders());
  }

  activeRoot(): string | undefined {
    return primaryRoot(this.current());
  }

  signature(): string {
    return workspaceSignature(this.options.getFolders());
  }

  sync(): { changed: boolean; root: string | undefined } {
    const signature = this.signature();
    const changed = this.lastSignature !== undefined && this.lastSignature !== signature;
    const first = this.lastSignature === undefined;
    this.lastSignature = signature;
    const resolution = this.current();
    if (resolution.kind === 'multi') {
      if (changed || first) {
        this.options.notifyMultiRoot(resolution.roots);
      }
    }
    const root = primaryRoot(resolution);
    if (changed) {
      this.options.onWorkspaceChanged?.(root);
    }
    return { changed: changed || first, root };
  }

  isCurrent(root: string): boolean {
    return this.activeRoot() === root;
  }
}
