import type { Diagnostic, DiagnosticRule, DiagnosticContext } from '../../core/interfaces.js';

export const projectDiagnosticRule: DiagnosticRule = {
  id: 'project-config-check',
  name: 'Project Configuration Check',
  category: 'project',
  severity: 'warning',
  
  diagnose(context: DiagnosticContext): Promise<ReadonlyArray<Diagnostic>> {
    const diagnostics: Diagnostic[] = [];
    
    // Check for parse errors in requirements
    for (const parsedReq of context.requirements) {
      for (const error of parsedReq.parseErrors) {
        const severity = error.severity === 'error' ? 'error' : 'warning';
        diagnostics.push({
          id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          code: 'PROJECT_PARSE_ERROR',
          severity,
          category: 'project',
          title: `Parse error in ${error.sourceFile}`,
          message: error.error,
          evidence: [
            { source: 'requirement', description: error.error, file: error.sourceFile },
          ],
          affectedFiles: [error.sourceFile],
          source: 'project-scanner',
          timestamp: new Date(),
          metadata: { parseError: true, code: error.code },
        });
      }
    }
    
    return Promise.resolve(diagnostics);
  },
};