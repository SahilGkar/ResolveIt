import type { Diagnostic, DiagnosticRule, DiagnosticContext, DiagnosticSeverity, DiagnosticEvidence, RemediationCandidate, ProjectRequirement } from '../../core/interfaces.js';

function createDiagnostic(
  requirement: ProjectRequirement,
  severity: DiagnosticSeverity,
  message: string,
  evidence: DiagnosticEvidence[],
  remediationCandidates: RemediationCandidate[]
): Diagnostic {
  return {
    id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    code: `DEPENDENCY_${requirement.type.toUpperCase()}_MISMATCH`,
    severity,
    category: 'dependency',
    title: `Dependency: ${requirement.name}`,
    message,
    evidence,
    affectedFiles: [requirement.sourceFile],
    requirement,
    remediationCandidates,
    source: 'dependency-resolver',
    timestamp: new Date(),
    metadata: { ecosystem: requirement.ecosystem, type: requirement.type },
  };
}

/**
 * Ecosystems the controlled installer can actually service. A requirement from an
 * ecosystem outside this table is still reported as a diagnostic, but no install
 * remediation is proposed because no controlled tool exists for it.
 */
const ECOSYSTEM_TO_PACKAGE_MANAGER: Readonly<Record<string, string>> = {
  node: 'npm',
  python: 'pip',
  rust: 'cargo',
  go: 'go',
  php: 'composer',
  ruby: 'bundler',
};

function isManagedRequirement(requirement: ProjectRequirement): boolean {
  return (
    requirement.origin === 'lockfile' ||
    requirement.origin === 'transitive' ||
    requirement.metadata?.indirect === true
  );
}

function createLockfileInventoryDiagnostic(
  sourceFile: string,
  requirements: ReadonlyArray<ProjectRequirement>
): Diagnostic {
  const names = [...requirements.map((req) => req.name)].sort();
  return {
    id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    code: 'DEPENDENCY_LOCKFILE_INVENTORY',
    severity: 'info',
    category: 'dependency',
    title: `Dependency inventory: ${sourceFile} (${requirements.length} locked packages)`,
    message:
      `${requirements.length} locked/transitive packages are recorded in ${sourceFile}. ` +
      'They are managed through the manifest and the package manager, never installed individually. ' +
      'Status: unknown - no local package inventory available',
    evidence: names.map((name) => {
      const req = requirements.find((entry) => entry.name === name);
      return {
        source: 'requirement' as const,
        description: `${name}${req?.versionConstraint ? ` ${req.versionConstraint}` : ''}`,
        key: req?.sourceSection,
        file: sourceFile,
      };
    }),
    affectedFiles: [sourceFile],
    // Deliberately no `requirement`: this diagnostic summarizes a whole file,
    // not one requirement. Per-package names and versions live in evidence so
    // no information is lost by the aggregation.
    remediationCandidates: [],
    source: 'dependency-resolver',
    timestamp: new Date(),
    metadata: { type: 'lockfile-inventory', packageCount: requirements.length },
  };
}

function createRemediationCandidates(requirement: ProjectRequirement): RemediationCandidate[] {
  // Lockfile/transitive/indirect packages are managed through the manifest and the
  // package manager, never installed individually.
  if (requirement.origin === 'lockfile' || requirement.origin === 'transitive') {
    return [];
  }
  if (requirement.metadata?.indirect === true) {
    return [];
  }

  // Without an ecosystem the installer tool rejects the action outright
  // ("Unsupported ecosystem: undefined"), so never propose an install we cannot run.
  const ecosystem = ECOSYSTEM_TO_PACKAGE_MANAGER[requirement.ecosystem];
  if (!ecosystem) {
    return [];
  }

  return [
    {
      id: `rem-${Date.now()}-install`,
      type: 'install-dependency',
      description: `Install ${requirement.name}${requirement.versionConstraint ? ` ${requirement.versionConstraint}` : ''}`,
      confidence: 0.7,
      riskLevel: 'project-modification',
      payload: {
        ecosystem,
        package: requirement.name,
        ...(requirement.versionConstraint ? { version: requirement.versionConstraint } : {}),
        developmentOnly: requirement.developmentOnly === true,
      },
    },
  ];
}

export const dependencyDiagnosticRule: DiagnosticRule = {
  id: 'dependency-check',
  name: 'Dependency Check',
  category: 'dependency',
  severity: 'warning',
  
  diagnose(context: DiagnosticContext): Promise<ReadonlyArray<Diagnostic>> {
    const diagnostics: Diagnostic[] = [];
    const depRequirements = context.requirements.flatMap(r =>
      r.requirements.filter(req => req.type === 'package-dependency')
    );

    // Note: Phase 2 environment scanner does not currently maintain a complete
    // inventory of installed project dependencies. We cannot definitively say
    // whether a dependency is missing or incompatible.
    //
    // This rule will produce "unknown" state diagnostics when it cannot
    // determine the status of a dependency.

    // Direct declarations get one diagnostic each: they are actionable.
    for (const req of depRequirements.filter((entry) => !isManagedRequirement(entry))) {
      // We don't have a complete package inventory from Phase 2
      // So we emit an informational diagnostic about the unknown state
      diagnostics.push(createDiagnostic(
        req,
        'info',
        `Dependency ${req.name}${req.versionConstraint ? ` ${req.versionConstraint}` : ''} declared in ${req.sourceFile} (${req.sourceSection}). Status: unknown - no local package inventory available`,
        [
          { source: 'requirement', description: `${req.name}${req.versionConstraint ? ` ${req.versionConstraint}` : ''}`, key: req.sourceSection, file: req.sourceFile },
          { source: 'environment', description: 'No local package inventory available', expected: req.versionConstraint || 'any', actual: 'unknown' },
        ],
        createRemediationCandidates(req)
      ));
    }

    // Locked/transitive entries are inventory, not problems: one aggregated
    // diagnostic per lockfile instead of hundreds of per-package rows. A lone
    // entry keeps the per-package shape so single-package evidence (including
    // resolved versions) is preserved verbatim.
    const managed = depRequirements.filter((entry) => isManagedRequirement(entry));
    const byFile = new Map<string, ProjectRequirement[]>();
    for (const req of managed) {
      const group = byFile.get(req.sourceFile) ?? [];
      group.push(req);
      byFile.set(req.sourceFile, group);
    }
    for (const [sourceFile, group] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (group.length === 1 && group[0]) {
        const req = group[0];
        diagnostics.push(createDiagnostic(
          req,
          'info',
          `Dependency ${req.name}${req.versionConstraint ? ` ${req.versionConstraint}` : ''} recorded in ${req.sourceFile} (${req.sourceSection}). Status: unknown - no local package inventory available`,
          [
            { source: 'requirement', description: `${req.name}${req.versionConstraint ? ` ${req.versionConstraint}` : ''}`, key: req.sourceSection, file: req.sourceFile },
            { source: 'environment', description: 'No local package inventory available', expected: req.versionConstraint || 'any', actual: 'unknown' },
          ],
          []
        ));
      } else {
        diagnostics.push(createLockfileInventoryDiagnostic(sourceFile, group));
      }
    }

    return Promise.resolve(diagnostics);
  },
}