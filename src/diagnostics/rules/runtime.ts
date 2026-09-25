import type { Diagnostic, DiagnosticRule, DiagnosticContext, DiagnosticSeverity, DiagnosticEvidence, RemediationCandidate, ProjectRequirement, VersionMatchResult } from '../../core/interfaces.js';
import { versionMatcher } from '../version-matcher.js';

function createDiagnostic(
  requirement: ProjectRequirement,
  severity: DiagnosticSeverity,
  message: string,
  evidence: DiagnosticEvidence[],
  remediationCandidates: RemediationCandidate[]
): Diagnostic {
  return {
    id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    code: `RUNTIME_${requirement.type.toUpperCase()}_MISMATCH`,
    severity,
    category: 'runtime',
    title: `${requirement.name} version mismatch`,
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
  const candidates: RemediationCandidate[] = [];
  
  if (requirement.type === 'runtime-version') {
    candidates.push({
      id: `rem-${Date.now()}-install`,
      type: 'install-dependency',
      description: `Install ${requirement.name} ${requirement.versionConstraint || 'latest'}`,
      confidence: 0.8,
      riskLevel: 'system-modification',
      payload: { tool: requirement.name, version: requirement.versionConstraint },
    });
    
    candidates.push({
      id: `rem-${Date.now()}-upgrade`,
      type: 'upgrade-runtime',
      description: `Upgrade ${requirement.name} to ${requirement.versionConstraint || 'latest'}`,
      confidence: 0.9,
      riskLevel: 'system-modification',
      payload: { tool: requirement.name, version: requirement.versionConstraint },
    });
  }
  
  return candidates;
}

export const runtimeDiagnosticRule: DiagnosticRule = {
  id: 'runtime-version-check',
  name: 'Runtime Version Check',
  category: 'runtime',
  severity: 'error',
  
  diagnose(context: DiagnosticContext): Promise<ReadonlyArray<Diagnostic>> {
    const diagnostics: Diagnostic[] = [];
    const runtimeRequirements = context.requirements.flatMap(r => 
      r.requirements.filter(req => req.type === 'runtime-version' || req.type === 'language-version')
    );
    
    for (const req of runtimeRequirements) {
      const envRuntime = context.environment.runtimes.find((r: { name: string; command: string; available: boolean }) => 
        r.name.toLowerCase() === req.name.toLowerCase() ||
        r.command.toLowerCase().includes(req.name.toLowerCase())
      );
      
      if (!envRuntime || !envRuntime.available) {
        diagnostics.push(createDiagnostic(
          req,
          'error',
          `Required ${req.name} runtime is not installed`,
          [
            { source: 'requirement', description: `${req.name} ${req.versionConstraint || ''}`, key: req.sourceSection, file: req.sourceFile },
            { source: 'environment', description: `${req.name} not found in environment`, expected: req.versionConstraint || 'any', actual: 'missing' },
          ],
          createRemediationCandidates(req)
        ));
        continue;
      }
      
      const versionConstraint = (req.versionConstraint ?? '*');
      if (versionConstraint === '*') {
        // No version constraint - just need the runtime to be present
        continue;
      }
      
      const match = versionMatcher.matches(versionConstraint, envRuntime.version ?? 'unknown');
      
      if (!match.satisfied) {
        if (match.reason === 'unknown') {
          const unknownMatch = match as VersionMatchResult & { reason: 'unknown'; details: string };
          diagnostics.push(createDiagnostic(
            req,
            'warning',
            `Cannot verify ${req.name} version constraint: ${unknownMatch.details}`,
            [
              { source: 'requirement', description: `${req.name} ${versionConstraint}`, key: req.sourceSection, file: req.sourceFile },
              { source: 'environment', description: `${req.name} ${envRuntime.version}`, expected: versionConstraint, actual: envRuntime.version },
            ],
            createRemediationCandidates(req)
          ));
        } else {
          diagnostics.push(createDiagnostic(
            req,
            'error',
            `${req.name} version ${envRuntime.version} does not satisfy requirement ${versionConstraint}: ${match.reason}`,
            [
              { source: 'requirement', description: `${req.name} ${versionConstraint}`, key: req.sourceSection, file: req.sourceFile },
              { source: 'environment', description: `${req.name} ${envRuntime.version}`, expected: versionConstraint, actual: envRuntime.version },
            ],
            createRemediationCandidates(req)
          ));
        }
      }
    }
    
    return Promise.resolve(diagnostics);
  },
};