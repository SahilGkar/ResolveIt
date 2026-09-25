import type { Diagnostic, DiagnosticRule, DiagnosticContext, ProjectRequirement } from '../../core/interfaces.js';

function isExactConstraint(constraint: string | undefined): boolean {
  if (!constraint) {
    return false;
  }
  const trimmed = constraint.trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'latest') {
    return false;
  }
  if (/^(>=|<=|>|<|~|\^|\|\||\.\.| - )/.test(trimmed)) {
    return false;
  }
  if (/[[\]()|]/.test(trimmed)) {
    return false;
  }
  if (/[,+]/.test(trimmed) && !/^\d+\.\d+/.test(trimmed)) {
    return false;
  }
  return true;
}

export const crossProjectDiagnosticRule: DiagnosticRule = {
  id: 'cross-project-version-check',
  name: 'Cross-Project Version Check',
  category: 'project',
  severity: 'info',

  diagnose(context: DiagnosticContext): Promise<ReadonlyArray<Diagnostic>> {
    const diagnostics: Diagnostic[] = [];
    const runtimeRequirements = context.requirements.flatMap((parsed) =>
      parsed.requirements.filter(
        (req): req is ProjectRequirement & { versionConstraint: string } =>
          (req.type === 'runtime-version' || req.type === 'language-version') &&
          typeof req.versionConstraint === 'string'
      )
    );

    const byRuntime = new Map<string, ProjectRequirement[]>();
    for (const req of runtimeRequirements) {
      const key = `${req.ecosystem}|${req.name.toLowerCase()}`;
      const existing = byRuntime.get(key) ?? [];
      existing.push(req);
      byRuntime.set(key, existing);
    }

    for (const [key, reqs] of byRuntime) {
      const files = new Set(reqs.map((req) => req.sourceFile));
      if (files.size < 2) {
        continue;
      }
      const exact = reqs.filter((req) => isExactConstraint(req.versionConstraint));
      const distinct = new Set(exact.map((req) => req.versionConstraint?.trim()));
      if (exact.length < 2 || distinct.size < 2) {
        continue;
      }
      const detail = [...distinct].join(' vs ');
      diagnostics.push({
        id: `diag-${Date.now()}-${key.replace(/[^a-zA-Z0-9]+/g, '-')}`,
        code: 'CROSS_PROJECT_RUNTIME_DIVERGENCE',
        severity: 'info',
        category: 'project',
        title: `${reqs[0]?.name ?? key} pinned to different versions across projects`,
        message: `The same runtime is pinned to different exact versions in multiple projects (${detail}). Each project keeps its own requirement; align them only if they must share a runtime.`,
        evidence: reqs.map((req) => ({
          source: 'requirement' as const,
          description: `${req.name} ${req.versionConstraint ?? ''}`.trim(),
          file: req.sourceFile,
          expected: req.versionConstraint,
        })),
        affectedFiles: [...files],
        source: 'dependency-resolver',
        timestamp: new Date(),
        metadata: { crossProject: true, runtime: key },
      });
    }

    return Promise.resolve(diagnostics);
  },
};
