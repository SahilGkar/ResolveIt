import type { Diagnostic } from '../core/models.js';
import { createDiagnosticEngine } from '../diagnostics/index.js';
import type { AgentObservation } from './observation.js';

export interface AgentAnalysis {
  readonly observation: AgentObservation;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly blockingDiagnostics: ReadonlyArray<Diagnostic>;
  readonly timestamp: Date;
}

export function isBlockingDiagnostic(diagnostic: Diagnostic): boolean {
  return diagnostic.severity === 'error' || diagnostic.severity === 'critical';
}

export function diagnosticKey(diagnostic: Diagnostic): string {
  const requirement = diagnostic.requirement;
  if (requirement) {
    return [
      diagnostic.category,
      diagnostic.code,
      requirement.ecosystem,
      requirement.name,
      requirement.type,
      requirement.sourceFile,
    ].join('|');
  }
  const affected = diagnostic.affectedFiles?.[0] ?? '';
  return [diagnostic.category, diagnostic.code, diagnostic.title, affected].join('|');
}

export async function analyzeObservation(observation: AgentObservation): Promise<AgentAnalysis> {
  const engine = createDiagnosticEngine();
  const diagnostics = await engine.runDiagnosticsWithContext(
    observation.workspace,
    observation.environment,
    observation.requirements
  );

  return {
    observation,
    diagnostics,
    blockingDiagnostics: diagnostics.filter(isBlockingDiagnostic),
    timestamp: new Date(),
  };
}
