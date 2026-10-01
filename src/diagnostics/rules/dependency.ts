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

function createRemediationCandidates(requirement: ProjectRequirement): RemediationCandidate[] {
  // Skip lockfile/transitive dependencies - they are managed through their manifest
  if (requirement.origin === 'lockfile' || requirement.origin === 'transitive') {
    return [];
  }
  const indirect = requirement.metadata?.indirect;
  if (indirect === true) {
    return [];
  }
  
  const candidates: RemediationCandidate[] = [];
  
  candidates.push({
    id: `rem-${Date.now()}-install`,
    type: 'install-dependency',
    description: `Install ${requirement.name}${requirement.versionConstraint ? ` ${requirement.versionConstraint}` : ''}`,
    confidence: 0.7,
    riskLevel: 'project-modification',
    payload: { package: requirement.name, version: requirement.versionConstraint },
  });
  
  return candidates;
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
    
    for (const req of depRequirements) {
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
    
    return Promise.resolve(diagnostics);
  },
};