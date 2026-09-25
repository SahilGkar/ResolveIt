export const SECURITY_LIMITS = {
  maxPathLength: 1024,
  maxFileContentBytes: 256 * 1024,
  maxRepairContentBytes: 256 * 1024,
  maxFindReplaceBytes: 64 * 1024,
  maxPackageNameLength: 214,
  maxVersionLength: 128,
  maxAiResponseBytes: 256 * 1024,
  maxAiActions: 16,
  maxAiParameterBytes: 16 * 1024,
  maxAiParameterDepth: 5,
  maxAuditQueryResults: 200,
  maxAuditFileBytes: 5 * 1024 * 1024,
  maxCommandOutputBytes: 256 * 1024,
  maxCommandTimeoutMs: 120000,
  defaultCommandTimeoutMs: 60000,
  maxRequirementFileBytes: 1024 * 1024,
  maxRequirementFiles: 500,
  maxDockerFileBytes: 512 * 1024,
  maxDockerFindings: 50,
  maxDiagnosticEvidenceChars: 2000,
  maxContextDiagnostics: 100,
  maxContextRequirements: 500,
} as const;

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}…[truncated]`;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

export function exceedsBytes(text: string, maxBytes: number): boolean {
  return byteLength(text) > maxBytes;
}

export function parameterDepth(value: unknown, seen = new Set<object>()): number {
  if (value === null || typeof value !== 'object') {
    return 0;
  }
  if (seen.has(value)) {
    return 101;
  }
  seen.add(value);
  let maxChild = 0;
  const entries = Array.isArray(value) ? value : Object.values(value);
  for (const entry of entries) {
    const child = parameterDepth(entry, seen);
    if (child > maxChild) {
      maxChild = child;
    }
  }
  seen.delete(value);
  return maxChild + 1;
}
