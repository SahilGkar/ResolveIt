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
    code: `CONTAINER_${requirement.type.toUpperCase()}_MISMATCH`,
    severity,
    category: 'container',
    title: `Container requirement: ${requirement.name}`,
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

function createRemediationCandidates(_requirement: ProjectRequirement): RemediationCandidate[] {
  const candidates: RemediationCandidate[] = [];
  
  candidates.push({
    id: `rem-${Date.now()}-install`,
    type: 'install-tool',
    description: `Install Docker`,
    confidence: 0.8,
    riskLevel: 'system-modification',
    payload: { tool: 'docker' },
  });
  
  candidates.push({
    id: `rem-${Date.now()}-start-daemon`,
    type: 'run-script',
    description: 'Start Docker daemon',
    confidence: 0.7,
    riskLevel: 'system-modification',
    payload: { script: 'start-docker' },
  });
  
  return candidates;
}

export const containerDiagnosticRule: DiagnosticRule = {
  id: 'container-check',
  name: 'Container Check',
  category: 'container',
  severity: 'error',
  
  diagnose(context: DiagnosticContext): Promise<ReadonlyArray<Diagnostic>> {
    const diagnostics: Diagnostic[] = [];
    const containerRequirements = context.requirements.flatMap(r => 
      r.requirements.filter(req => req.type === 'container-image')
    );
    
    if (containerRequirements.length === 0) {
return Promise.resolve(diagnostics);
    }
    
    const dockerTool = context.environment.devTools.find((t: { name: string }) => t.name.toLowerCase() === 'docker');
    const dockerRunning = context.environment.containers?.dockerRunning;
    
    for (const req of containerRequirements) {
      if (!dockerTool || !dockerTool.available) {
        diagnostics.push(createDiagnostic(
          req,
          'error',
          `Docker is required but not installed`,
          [
            { source: 'requirement', description: `${req.name}:${req.versionConstraint || 'latest'}`, key: req.sourceSection, file: req.sourceFile },
            { source: 'environment', description: 'Docker not installed', expected: 'installed', actual: 'missing' },
          ],
          createRemediationCandidates(req)
        ));
        continue;
      }
      
      if (!dockerRunning) {
        diagnostics.push(createDiagnostic(
          req,
          'warning',
          `Docker is installed but daemon is not running`,
          [
            { source: 'requirement', description: `${req.name}:${req.versionConstraint || 'latest'}`, key: req.sourceSection, file: req.sourceFile },
            { source: 'environment', description: 'Docker CLI available but daemon not running', expected: 'running', actual: 'stopped' },
          ],
          createRemediationCandidates(req)
        ));
      }
    }
    
    return Promise.resolve(diagnostics);
  },
};