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
    code: `BUILD_${requirement.type.toUpperCase()}_MISMATCH`,
    severity,
    category: 'build',
    title: `Build requirement: ${requirement.name}`,
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
  
  candidates.push({
    id: `rem-${Date.now()}-install`,
    type: 'install-tool',
    description: `Install ${requirement.name}${requirement.versionConstraint ? ` ${requirement.versionConstraint}` : ''}`,
    confidence: 0.8,
    riskLevel: 'system-modification',
    payload: { tool: requirement.name, version: requirement.versionConstraint },
  });
  
  return candidates;
}

export const buildDiagnosticRule: DiagnosticRule = {
  id: 'build-tool-check',
  name: 'Build Tool Check',
  category: 'build',
  severity: 'error',
  
  diagnose(context: DiagnosticContext): Promise<ReadonlyArray<Diagnostic>> {
    const diagnostics: Diagnostic[] = [];
    const buildRequirements = context.requirements.flatMap(r => 
      r.requirements.filter(req => 
        req.type === 'build-tool' ||
        (req.type === 'toolchain' && ['cmake', 'make', 'ninja', 'meson', 'bazel', 'gradle', 'maven', 'cargo', 'go'].includes(req.name.toLowerCase()))
      )
    );
    
    for (const req of buildRequirements) {
      const envTool = context.environment.devTools.find((t: { name: string; command: string; available: boolean }) => 
        t.name.toLowerCase() === req.name.toLowerCase() ||
        t.command.toLowerCase().includes(req.name.toLowerCase())
      );
      
      if (!envTool || !envTool.available) {
        diagnostics.push(createDiagnostic(
          req,
          'error',
          `Required build tool ${req.name} is not available`,
          [
            { source: 'requirement', description: `${req.name}${req.versionConstraint ? ` ${req.versionConstraint}` : ''}`, key: req.sourceSection, file: req.sourceFile },
            { source: 'environment', description: `${req.name} not found in environment`, expected: req.versionConstraint || 'any', actual: 'missing' },
          ],
          createRemediationCandidates(req)
        ));
        continue;
      }
      
      if (!req.versionConstraint) {
        continue;
      }
      
      const match = versionMatcher.matches(req.versionConstraint, envTool.version || 'unknown');
      
      if (!match.satisfied) {
        if (match.reason === 'unknown') {
          const unknownMatch = match as VersionMatchResult & { reason: 'unknown'; details: string };
          diagnostics.push(createDiagnostic(
            req,
            'warning',
            `Cannot verify ${req.name} version constraint: ${unknownMatch.details}`,
            [
              { source: 'requirement', description: `${req.name} ${req.versionConstraint}`, key: req.sourceSection, file: req.sourceFile },
              { source: 'environment', description: `${req.name} ${envTool.version || 'unknown'}`, expected: req.versionConstraint, actual: envTool.version },
            ],
            createRemediationCandidates(req)
          ));
        } else {
          diagnostics.push(createDiagnostic(
            req,
            'error',
            `${req.name} version ${envTool.version || 'unknown'} does not satisfy requirement ${req.versionConstraint}: ${match.reason}`,
            [
              { source: 'requirement', description: `${req.name} ${req.versionConstraint}`, key: req.sourceSection, file: req.sourceFile },
              { source: 'environment', description: `${req.name} ${envTool.version || 'unknown'}`, expected: req.versionConstraint, actual: envTool.version },
            ],
            createRemediationCandidates(req)
          ));
        }
      }
    }
    
    return Promise.resolve(diagnostics);
  },
};