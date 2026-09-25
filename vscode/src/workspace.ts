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
