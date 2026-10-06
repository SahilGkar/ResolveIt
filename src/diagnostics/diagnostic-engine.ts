import type { 
  Diagnostic, 
  DiagnosticRule, 
  DiagnosticContext, 
  DiagnosticEngine, 
  VersionMatcher, 
  Workspace, 
  EnvironmentInfo,
  ParsedRequirements,
  DiagnosticSeverity,
  DiagnosticCategory 
} from '../core/interfaces.js';
import { versionMatcher } from './version-matcher.js';
import {
  runtimeDiagnosticRule,
  toolchainDiagnosticRule,
  containerDiagnosticRule,
  dockerSecurityDiagnosticRule,
  dependencyDiagnosticRule,
  buildDiagnosticRule,
  projectDiagnosticRule,
  crossProjectDiagnosticRule
} from './rules/index.js';

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  critical: 0,
  error: 1,
  warning: 2,
  info: 3,
  hint: 4,
};

const CATEGORY_ORDER: Record<DiagnosticCategory, number> = {
  runtime: 0,
  toolchain: 1,
  build: 2,
  container: 3,
  dependency: 4,
  project: 5,
  configuration: 6,
  environment: 7,
  unknown: 8,
};

function generateDedupKey(diagnostic: Diagnostic): string {
  const req = diagnostic.requirement;
  if (req) {
    // Origin is part of the key so a manifest declaration and its lockfile
    // twin are never collapsed: they mean different things (actionable vs
    // managed-through-the-manifest). Source file alone is NOT included so
    // identical declarations across nested projects still deduplicate.
    return `${diagnostic.category}-${req.ecosystem}-${req.name}-${req.type}-${req.origin ?? 'direct'}`;
  }
  return `${diagnostic.category}-${diagnostic.code}-${diagnostic.title}`;
}

function sortDiagnostics(a: Diagnostic, b: Diagnostic): number {
  // Sort by severity first
  const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (severityDiff !== 0) return severityDiff;
  
  // Then by category
  const categoryDiff = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
  if (categoryDiff !== 0) return categoryDiff;
  
  // Then by title for determinism
  return a.title.localeCompare(b.title);
}

export class DiagnosticEngineImpl implements DiagnosticEngine {
  private rules: DiagnosticRule[] = [];
  private versionMatcher: VersionMatcher = versionMatcher;
  
  constructor() {
    this.registerDefaultRules();
  }
  
  private registerDefaultRules(): void {
    this.registerRule(runtimeDiagnosticRule);
    this.registerRule(toolchainDiagnosticRule);
    this.registerRule(containerDiagnosticRule);
    this.registerRule(dockerSecurityDiagnosticRule);
    this.registerRule(dependencyDiagnosticRule);
    this.registerRule(buildDiagnosticRule);
    this.registerRule(projectDiagnosticRule);
    this.registerRule(crossProjectDiagnosticRule);
  }
  
  registerRule(rule: DiagnosticRule): void {
    this.rules.push(rule);
  }
  
  getRules(): ReadonlyArray<DiagnosticRule> {
    return [...this.rules];
  }
  
  runDiagnostics(_workspace: Workspace): Promise<ReadonlyArray<Diagnostic>> {
    // This is a placeholder - the actual implementation will be in the 
    // diagnose function that combines workspace, environment, and requirements
    return Promise.resolve([]);
  }
  
  async runDiagnosticsWithContext(
    workspace: Workspace,
    environment: EnvironmentInfo,
    requirements: ReadonlyArray<ParsedRequirements>
  ): Promise<ReadonlyArray<Diagnostic>> {
    const context: DiagnosticContext = {
      workspace,
      environment,
      requirements,
      versionMatcher: this.versionMatcher,
    };
    
    const allDiagnostics: Diagnostic[] = [];
    
    for (const rule of this.rules) {
      try {
        const ruleDiagnostics = await rule.diagnose(context);
        allDiagnostics.push(...ruleDiagnostics);
      } catch (err) {
        // Log rule error but continue with other rules
        console.error(`Diagnostic rule ${rule.id} failed:`, err);
      }
    }
    
    // Deduplicate diagnostics
    const deduplicated = this.deduplicateDiagnostics(allDiagnostics);
    
    // Sort diagnostics deterministically
    return deduplicated.sort(sortDiagnostics);
  }
  
  private deduplicateDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
    const seen = new Set<string>();
    const deduplicated: Diagnostic[] = [];
    
    for (const diag of diagnostics) {
      const key = generateDedupKey(diag);
      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(diag);
      }
    }
    
    return deduplicated;
  }
}

export function createDiagnosticEngine(): DiagnosticEngine {
  return new DiagnosticEngineImpl();
}

export { versionMatcher };