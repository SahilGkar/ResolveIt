import type { Diagnostic } from '../core/models.js';
import type { DiagnosticRule, VersionMatcher, DiagnosticContext } from '../core/interfaces.js';
import { DiagnosticEngineImpl, createDiagnosticEngine, versionMatcher } from './diagnostic-engine.js';
import { 
  runtimeDiagnosticRule, 
  toolchainDiagnosticRule, 
  containerDiagnosticRule, 
  dependencyDiagnosticRule, 
  buildDiagnosticRule, 
  projectDiagnosticRule,
  crossProjectDiagnosticRule
} from './rules/index.js';
import { scanWorkspace } from '../scanners/index.js';
import { scanEnvironment } from '../environment/index.js';
import { scanRequirements } from '../requirements/index.js';

export interface DiagnoseOptions {
  readonly workspaceRoot: string;
  readonly timeout?: number;
}

export async function diagnose(options: DiagnoseOptions): Promise<ReadonlyArray<Diagnostic>> {
  const { workspaceRoot, timeout = 60000 } = options;
  
  const [workspace, environment, requirements] = await Promise.all([
    scanWorkspace(workspaceRoot, { maxDepth: 50, maxFiles: 100000 }),
    scanEnvironment({ timeout }),
    scanRequirements(workspaceRoot, { timeout }),
  ]);
  
  const engine = createDiagnosticEngine();
  return engine.runDiagnosticsWithContext(workspace, environment, requirements);
}

export function formatDiagnosticsSummary(diagnostics: ReadonlyArray<Diagnostic>): string {
  const lines: string[] = [];
  lines.push('ResolveIt Diagnostics');
  lines.push('');
  
  if (diagnostics.length === 0) {
    lines.push('No diagnostics found.');
    return lines.join('\n');
  }
  
  const bySeverity = new Map<string, Diagnostic[]>();
  for (const diag of diagnostics) {
    const existing = bySeverity.get(diag.severity) || [];
    bySeverity.set(diag.severity, [...existing, diag]);
  }
  
  const severityOrder = ['critical', 'error', 'warning', 'info', 'hint'];
  
  for (const severity of severityOrder) {
    const diags = bySeverity.get(severity);
    if (!diags || diags.length === 0) continue;
    
    lines.push(`${severity.toUpperCase()}`);
    for (const diag of diags) {
      lines.push(`  ${diag.title}`);
      lines.push(`  ${diag.message}`);
      
      if (diag.evidence.length > 0) {
        for (const ev of diag.evidence) {
          lines.push(`  Source: ${ev.source} - ${ev.description}`);
          if (ev.expected !== undefined) {
            lines.push(`    Expected: ${String(ev.expected)}`);
          }
          if (ev.actual !== undefined) {
            lines.push(`    Actual: ${String(ev.actual)}`);
          }
        }
      }
      
      if (diag.remediationCandidates && diag.remediationCandidates.length > 0) {
        lines.push(`  Remediation candidates:`);
        for (const rem of diag.remediationCandidates) {
          lines.push(`    - ${rem.description} (confidence: ${Math.round(rem.confidence * 100)}%)`);
        }
      }
      lines.push('');
    }
  }
  
  lines.push('Summary');
  lines.push(`  Total diagnostics: ${diagnostics.length}`);
  for (const severity of severityOrder) {
    const count = (bySeverity.get(severity) || []).length;
    if (count > 0) {
      lines.push(`  ${severity}: ${count}`);
    }
  }
  
  return lines.join('\n');
}

export function diagnosticsToJSON(diagnostics: ReadonlyArray<Diagnostic>): string {
  return JSON.stringify({
    total: diagnostics.length,
    bySeverity: {
      critical: diagnostics.filter(d => d.severity === 'critical').length,
      error: diagnostics.filter(d => d.severity === 'error').length,
      warning: diagnostics.filter(d => d.severity === 'warning').length,
      info: diagnostics.filter(d => d.severity === 'info').length,
      hint: diagnostics.filter(d => d.severity === 'hint').length,
    },
    byCategory: {
      runtime: diagnostics.filter(d => d.category === 'runtime').length,
      dependency: diagnostics.filter(d => d.category === 'dependency').length,
      toolchain: diagnostics.filter(d => d.category === 'toolchain').length,
      build: diagnostics.filter(d => d.category === 'build').length,
      container: diagnostics.filter(d => d.category === 'container').length,
      configuration: diagnostics.filter(d => d.category === 'configuration').length,
      project: diagnostics.filter(d => d.category === 'project').length,
      environment: diagnostics.filter(d => d.category === 'environment').length,
      unknown: diagnostics.filter(d => d.category === 'unknown').length,
    },
    diagnostics: diagnostics.map(d => ({
      id: d.id,
      code: d.code,
      severity: d.severity,
      category: d.category,
      title: d.title,
      message: d.message,
      evidence: d.evidence,
      affectedFiles: d.affectedFiles,
      requirement: d.requirement ? {
        id: d.requirement.id,
        ecosystem: d.requirement.ecosystem,
        type: d.requirement.type,
        name: d.requirement.name,
        versionConstraint: d.requirement.versionConstraint,
        sourceFile: d.requirement.sourceFile,
        sourceSection: d.requirement.sourceSection,
      } : undefined,
      remediationCandidates: d.remediationCandidates,
      source: d.source,
      timestamp: d.timestamp.toISOString(),
      metadata: d.metadata,
    })),
  }, null, 2);
}

export { 
  DiagnosticEngineImpl, 
  createDiagnosticEngine, 
  versionMatcher,
  runtimeDiagnosticRule,
  toolchainDiagnosticRule,
  containerDiagnosticRule,
  dependencyDiagnosticRule,
  buildDiagnosticRule,
  projectDiagnosticRule,
  crossProjectDiagnosticRule,
};
export type { DiagnosticRule, VersionMatcher, DiagnosticContext };