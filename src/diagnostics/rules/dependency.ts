import { resolve, sep } from 'node:path';
import type { Diagnostic, DiagnosticRule, DiagnosticContext, DiagnosticSeverity, DiagnosticEvidence, RemediationCandidate, ProjectRequirement } from '../../core/interfaces.js';
import { inspectNpmPackageInstallState } from '../installed-packages.js';

function createDiagnostic(
  requirement: ProjectRequirement,
  severity: DiagnosticSeverity,
  message: string,
  evidence: DiagnosticEvidence[],
  remediationCandidates: RemediationCandidate[],
  code?: string,
  metadata?: Record<string, unknown>
): Diagnostic {
  return {
    id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    code: code ?? `DEPENDENCY_${requirement.type.toUpperCase()}_MISMATCH`,
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
    metadata: { ecosystem: requirement.ecosystem, type: requirement.type, ...metadata },
  };
}

/**
 * Absolute directory holding the manifest a requirement was declared in.
 * `sourceFile` is workspace-relative, so joining it onto the workspace root
 * locates the project. The result is contained within the workspace root;
 * anything else falls back to the root itself rather than escaping.
 */
function projectDirOf(workspaceRoot: string, sourceFile: string): string {
  const root = resolve(workspaceRoot);
  const slash = sourceFile.lastIndexOf('/');
  const dir = slash === -1 ? '' : sourceFile.slice(0, slash);
  const candidate = dir === '' ? root : resolve(root, dir);
  if (candidate === root || candidate.startsWith(root + sep)) {
    return candidate;
  }
  return root;
}

/**
 * Requirements whose installed state this rule establishes deterministically:
 * direct npm production/development dependencies. Optional and peer
 * dependencies keep the previous informational behavior (a missing optional
 * or peer entry is not a repair problem), as do ecosystems without a local
 * tree inspector.
 */
function isInspectedRequirement(requirement: ProjectRequirement): boolean {
  if (requirement.ecosystem !== 'node') {
    return false;
  }
  if (requirement.optional === true) {
    return false;
  }
  const scope = requirement.metadata?.['scope'];
  return scope === 'production' || scope === 'development';
}

function requirementLabel(requirement: ProjectRequirement): string {
  return `${requirement.name}${requirement.versionConstraint ? ` ${requirement.versionConstraint}` : ''}`;
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
  
  async diagnose(context: DiagnosticContext): Promise<ReadonlyArray<Diagnostic>> {
    const diagnostics: Diagnostic[] = [];
    const depRequirements = context.requirements.flatMap(r =>
      r.requirements.filter(req => req.type === 'package-dependency')
    );

    // Direct declarations get one diagnostic each when they are a problem, and
    // none when the installed tree satisfies them. Installed state comes from
    // the actual project dependency tree (node_modules), never from the
    // manifest alone, a lockfile alone, or globally installed packages.

    // Direct declarations get one diagnostic each: they are actionable.
    for (const req of depRequirements.filter((entry) => !isManagedRequirement(entry))) {
      if (!isInspectedRequirement(req)) {
        // Optional/peer entries and ecosystems without a local tree inspector
        // keep the previous informational behavior: reported, never blocking.
        diagnostics.push(createDiagnostic(
          req,
          'info',
          `Dependency ${requirementLabel(req)} declared in ${req.sourceFile} (${req.sourceSection}). Status: unknown - no local package inventory available`,
          [
            { source: 'requirement', description: requirementLabel(req), key: req.sourceSection, file: req.sourceFile },
            { source: 'environment', description: 'No local package inventory available', expected: req.versionConstraint || 'any', actual: 'unknown' },
          ],
          createRemediationCandidates(req)
        ));
        continue;
      }
      const projectDir = projectDirOf(context.workspace.rootPath, req.sourceFile);
      const state = await inspectNpmPackageInstallState(projectDir, req.name);
      const checked = state.checkedPath;
      // A missing development dependency is a real gap but does not stop the
      // application from running, so it is an issue rather than blocking.
      const severity: DiagnosticSeverity = req.developmentOnly === true ? 'warning' : 'error';
      if (state.status === 'missing') {
        diagnostics.push(createDiagnostic(
          req,
          severity,
          `Project requires ${requirementLabel(req)} (declared in ${req.sourceFile}), but it is not currently installed (checked ${checked}).`,
          [
            { source: 'requirement', description: requirementLabel(req), key: req.sourceSection, file: req.sourceFile },
            { source: 'environment', description: `Checked ${checked}: project-local package not found`, expected: req.versionConstraint || 'any', actual: 'NOT FOUND' },
          ],
          createRemediationCandidates(req),
          'DEPENDENCY_PACKAGE_MISSING',
          { dependencyStatus: 'missing' }
        ));
        continue;
      }
      const installed = state.installedVersion as string;
      if (!req.versionConstraint || context.versionMatcher.matches(req.versionConstraint, installed).satisfied) {
        // Satisfied: no diagnostic. Silence here is the proof of health that
        // the workflow counts as "satisfied" — nothing is fabricated.
        continue;
      }
      diagnostics.push(createDiagnostic(
        req,
        severity,
        `Project requires ${requirementLabel(req)}, but the installed version is ${installed} (checked ${checked}).`,
        [
          { source: 'requirement', description: requirementLabel(req), key: req.sourceSection, file: req.sourceFile },
          { source: 'environment', description: `Checked ${checked}: installed version does not satisfy the requirement`, expected: req.versionConstraint, actual: installed },
        ],
        createRemediationCandidates(req),
        'DEPENDENCY_PACKAGE_VERSION_MISMATCH',
        { dependencyStatus: 'mismatched', installedVersion: installed }
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