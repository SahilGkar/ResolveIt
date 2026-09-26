export type OperationKind =
  | 'scan'
  | 'diagnose'
  | 'run'
  | 'environment'
  | 'requirements'
  | 'repair'
  | 'verify'
  | 'analyze';

export class OperationBusyError extends Error {
  readonly kind: OperationKind;
  readonly root: string;

  constructor(kind: OperationKind, root: string) {
    super(`ResolveIt ${kind} is already running for this workspace. Wait for it to finish first.`);
    this.name = 'OperationBusyError';
    this.kind = kind;
    this.root = root;
  }
}

export class OperationCancelledError extends Error {
  constructor() {
    super('ResolveIt operation was cancelled. No changes were applied after cancellation.');
    this.name = 'OperationCancelledError';
  }
}

export interface OperationToken {
  readonly id: number;
  readonly kind: OperationKind;
  readonly root: string;
  readonly startedAt: Date;
  readonly signal: { readonly cancelled: boolean };
  throwIfCancelled(): void;
}

interface ActiveOperation {
  readonly token: OperationToken;
  readonly cancel: () => void;
}

const MUTATING: ReadonlySet<OperationKind> = new Set(['run', 'repair']);

function lockKey(kind: OperationKind, root: string): string {
  if (MUTATING.has(kind)) {
    return `mutating:${root}`;
  }
  return `${kind}:${root}`;
}

export class OperationCoordinator {
  private nextId = 1;
  private readonly active = new Map<string, ActiveOperation>();

  activeCount(): number {
    return this.active.size;
  }

  isActive(kind: OperationKind, root: string): boolean {
    return this.active.has(lockKey(kind, root));
  }

  begin(kind: OperationKind, root: string): OperationToken {
    const key = lockKey(kind, root);
    if (this.active.has(key)) {
      throw new OperationBusyError(kind, root);
    }
    let cancelled = false;
    const token: OperationToken = {
      id: this.nextId,
      kind,
      root,
      startedAt: new Date(),
      signal: {
        get cancelled(): boolean {
          return cancelled;
        },
      },
      throwIfCancelled: () => {
        if (cancelled) {
          throw new OperationCancelledError();
        }
      },
    };
    this.nextId += 1;
    this.active.set(key, {
      token,
      cancel: () => {
        cancelled = true;
      },
    });
    return token;
  }

  cancel(kind: OperationKind, root: string): boolean {
    const operation = this.active.get(lockKey(kind, root));
    if (!operation) {
      return false;
    }
    operation.cancel();
    return true;
  }

  end(token: OperationToken): void {
    const current = this.active.get(lockKey(token.kind, token.root));
    if (current && current.token.id === token.id) {
      this.active.delete(lockKey(token.kind, token.root));
    }
  }

  async run<T>(kind: OperationKind, root: string, task: (token: OperationToken) => Promise<T>): Promise<T> {
    const token = this.begin(kind, root);
    try {
      return await task(token);
    } finally {
      this.end(token);
    }
  }
}
