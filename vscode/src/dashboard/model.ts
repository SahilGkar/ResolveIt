import type { Diagnostic } from '../../../src/index.js';
import type { ApprovalState } from '../state.js';

export type DashboardKind =
  | 'NOT_SCANNED'
  | 'ANALYZING'
  | 'HEALTHY'
  | 'PROBLEMS_FOUND'
  | 'AI_ANALYSIS_AVAILABLE'
  | 'REPAIR_PLAN_READY'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'APPLYING'
  | 'VERIFICATION'
  | 'RESOLVED'
  | 'PARTIALLY_RESOLVED'
  | 'FAILED';

export interface DashboardPrimaryAction {
  readonly label: string;
  readonly command: string;
  readonly enabled: boolean;
  readonly args?: ReadonlyArray<unknown>;
}

export interface DashboardSecondaryAction {
  readonly label: string;
  readonly command: string;
}

export interface DashboardCounts {
  readonly total: number;
  readonly blocking: number;
  readonly errors: number;
  readonly warnings: number;
  readonly requirements: number;
}

export interface DashboardPlanSummary {
  readonly actionCount: number;
  readonly decidedCount: number;
  readonly approvedCount: number;
  readonly stale: boolean;
}

export interface DashboardSnapshot {
  readonly hasWorkspace: boolean;
  readonly workspaceName?: string;
  readonly hasScanned: boolean;
  readonly activeOperation?: { readonly kind: string; readonly activity: string };
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly blockingCount: number;
  readonly requirementsCount: number;
  readonly environmentReady?: boolean;
  readonly aiAvailable: boolean;
  readonly aiProvider?: string;
  readonly aiModel?: string;
  readonly hasPlan: boolean;
  readonly planActionCount: number;
  readonly planDecidedCount: number;
  readonly planApprovedCount: number;
  readonly planStale: boolean;
  readonly hasExecution: boolean;
  readonly executionSucceeded: number;
  readonly executionFailed: number;
  readonly verificationResolved: number;
  readonly verificationRemaining: number;
  readonly hasVerification: boolean;
  readonly lastRunStatus?: string;
  readonly errorMessage?: string;
}

export interface DashboardModel {
  readonly kind: DashboardKind;
  readonly title: string;
  readonly description: string;
  readonly primary: DashboardPrimaryAction | undefined;
  readonly secondary: ReadonlyArray<DashboardSecondaryAction>;
  readonly counts: DashboardCounts;
  readonly plan?: DashboardPlanSummary;
  readonly showProgress: boolean;
  readonly progressMessage?: string;
}

function countBy(diagnostics: ReadonlyArray<Diagnostic>, severities: ReadonlyArray<string>): number {
  return diagnostics.filter((diagnostic) => severities.includes(diagnostic.severity)).length;
}

function isAnalyzingKind(kind: string): boolean {
  return kind === 'scan' || kind === 'diagnose' || kind === 'environment' || kind === 'requirements' || kind === 'analyze';
}

function isApplyingKind(kind: string): boolean {
  return kind === 'repair' || kind === 'run';
}

export function buildDashboardModel(snapshot: DashboardSnapshot): DashboardModel {
  const counts: DashboardCounts = {
    total: snapshot.diagnostics.length,
    blocking: snapshot.blockingCount,
    errors: countBy(snapshot.diagnostics, ['error', 'critical']),
    warnings: countBy(snapshot.diagnostics, ['warning']),
    requirements: snapshot.requirementsCount,
  };
  const plan: DashboardPlanSummary | undefined = snapshot.hasPlan
    ? {
        actionCount: snapshot.planActionCount,
        decidedCount: snapshot.planDecidedCount,
        approvedCount: snapshot.planApprovedCount,
        stale: snapshot.planStale,
      }
    : undefined;

  const operation = snapshot.activeOperation;
  if (operation && isAnalyzingKind(operation.kind)) {
    return {
      kind: 'ANALYZING',
      title: 'Analyzing project…',
      description: operation.activity || 'ResolveIt is checking this workspace. Results appear here when ready.',
      primary: undefined,
      secondary: [],
      counts,
      plan,
      showProgress: true,
      progressMessage: operation.activity,
    };
  }
  if (operation && isApplyingKind(operation.kind)) {
    const isAgentRun = operation.kind === 'run';
    return {
      kind: 'APPLYING',
      title: isAgentRun ? 'Agent run in progress…' : 'Applying repairs…',
      description:
        operation.activity ||
        (isAgentRun
          ? 'The ResolveIt agent is working. Approvals are still requested before anything is modified.'
          : 'ResolveIt is applying approved repairs. Nothing else runs until this finishes.'),
      primary: undefined,
      secondary: [{ label: 'View Details', command: 'resolveit.showDetails' }],
      counts,
      plan,
      showProgress: true,
      progressMessage: operation.activity,
    };
  }
  if (operation && operation.kind === 'verify') {
    return {
      kind: 'VERIFICATION',
      title: 'Verifying changes…',
      description: 'Re-running diagnostics and checking the repaired requirements.',
      primary: undefined,
      secondary: [{ label: 'View Details', command: 'resolveit.showDetails' }],
      counts,
      plan,
      showProgress: true,
      progressMessage: operation.activity,
    };
  }

  if (snapshot.errorMessage && !snapshot.hasVerification) {
    return {
      kind: 'FAILED',
      title: 'Repair could not be completed',
      description: snapshot.errorMessage,
      primary: { label: 'Try Again', command: 'resolveit.analyzeProject', enabled: true },
      secondary: [{ label: 'View Details', command: 'resolveit.showDetails' }],
      counts,
      plan,
      showProgress: false,
    };
  }

  if (snapshot.hasVerification) {
    if (snapshot.verificationRemaining === 0 && snapshot.verificationResolved > 0) {
      return {
        kind: 'RESOLVED',
        title: 'Project resolved',
        description: `All blocking diagnostics are resolved (${snapshot.verificationResolved} resolved).`,
        primary: { label: 'Verify Again', command: 'resolveit.verify', enabled: true },
        secondary: [{ label: 'Analyze Project', command: 'resolveit.analyzeProject' }],
        counts,
        plan,
        showProgress: false,
      };
    }
    if (snapshot.verificationRemaining > 0 && snapshot.verificationResolved > 0) {
      return {
        kind: 'PARTIALLY_RESOLVED',
        title: 'Partially resolved',
        description: `${snapshot.verificationResolved} resolved, ${snapshot.verificationRemaining} still need attention.`,
        primary: { label: 'Review Problems', command: 'resolveit.reviewProblems', enabled: true },
        secondary: [
          { label: 'Verify Again', command: 'resolveit.verify' },
          { label: 'View Details', command: 'resolveit.showDetails' },
        ],
        counts,
        plan,
        showProgress: false,
      };
    }
    if (snapshot.verificationRemaining > 0) {
      return {
        kind: 'PARTIALLY_RESOLVED',
        title: 'Verification did not pass',
        description: `${snapshot.verificationRemaining} blocking diagnostic(s) remain. No further changes were made automatically.`,
        primary: { label: 'Review Problems', command: 'resolveit.reviewProblems', enabled: true },
        secondary: [
          { label: 'Verify Again', command: 'resolveit.verify' },
          { label: 'View Details', command: 'resolveit.showDetails' },
        ],
        counts,
        plan,
        showProgress: false,
      };
    }
  }

  if (snapshot.hasExecution && snapshot.executionFailed > 0 && !snapshot.hasVerification) {
    return {
      kind: 'FAILED',
      title: 'Repair failed',
      description: `${snapshot.executionFailed} repair action(s) did not complete. No further changes were made automatically.`,
      primary: { label: 'Try Again', command: 'resolveit.analyzeProject', enabled: true },
      secondary: [{ label: 'View Details', command: 'resolveit.showDetails' }],
      counts,
      plan,
      showProgress: false,
    };
  }

  if (snapshot.hasPlan) {
    if (snapshot.planApprovedCount > 0 && snapshot.planDecidedCount >= snapshot.planActionCount) {
      return {
        kind: 'APPROVED',
        title: 'Repairs approved',
        description: `${snapshot.planApprovedCount} of ${snapshot.planActionCount} change(s) approved. ResolveIt applies them through the existing Core pipeline.`,
        primary: { label: 'Apply Approved Repairs', command: 'resolveit.applyApprovedRepairs', enabled: true },
        secondary: [{ label: 'Review Problems', command: 'resolveit.reviewProblems' }],
        counts,
        plan,
        showProgress: false,
      };
    }
    if (snapshot.planDecidedCount > 0) {
      return {
        kind: 'AWAITING_APPROVAL',
        title: 'Repair plan ready',
        description: `ResolveIt wants to make ${snapshot.planActionCount} change(s). Review each change before anything is modified.`,
        primary: {
          label: 'Apply Approved Repairs',
          command: 'resolveit.applyApprovedRepairs',
          enabled: snapshot.planApprovedCount > 0,
        },
        secondary: [{ label: 'Review Problems', command: 'resolveit.reviewProblems' }],
        counts,
        plan,
        showProgress: false,
      };
    }
    return {
      kind: 'REPAIR_PLAN_READY',
      title: 'Repair plan ready',
      description: `ResolveIt proposes ${snapshot.planActionCount} change(s). Nothing has been modified yet.`,
      primary: { label: 'Review Repairs', command: 'resolveit.reviewRepairs', enabled: true },
      secondary: [{ label: 'Review Problems', command: 'resolveit.reviewProblems' }],
      counts,
      plan,
      showProgress: false,
    };
  }

  if (!snapshot.hasWorkspace || !snapshot.hasScanned) {
    return {
      kind: 'NOT_SCANNED',
      title: snapshot.hasWorkspace ? 'Ready to analyze' : 'No folder open',
      description: snapshot.hasWorkspace
        ? "ResolveIt hasn't analyzed this workspace yet. Analysis is read-only and changes nothing."
        : 'Open a folder workspace first. ResolveIt analyzes the first folder of a multi-root workspace.',
      primary: { label: 'Analyze Project', command: 'resolveit.analyzeProject', enabled: snapshot.hasWorkspace },
      secondary: [],
      counts,
      plan,
      showProgress: false,
    };
  }

  if (snapshot.blockingCount === 0) {
    return {
      kind: 'HEALTHY',
      title: 'Project looks healthy',
      description:
        snapshot.diagnostics.length === 0
          ? 'No diagnostics were reported. The environment and requirements checks passed.'
          : 'No blocking diagnostics remain. Review warnings below if you want a fully clean state.',
      primary: { label: 'Analyze Project', command: 'resolveit.analyzeProject', enabled: true },
      secondary: [{ label: 'Verify Project', command: 'resolveit.verify' }],
      counts,
      plan,
      showProgress: false,
    };
  }

  if (snapshot.aiAvailable) {
    return {
      kind: 'AI_ANALYSIS_AVAILABLE',
      title: `${snapshot.blockingCount} issue${snapshot.blockingCount === 1 ? '' : 's'} found`,
      description: `AI planning is available (${snapshot.aiProvider ?? 'provider'} · ${snapshot.aiModel ?? 'model'}). ResolveIt can generate a repair plan for review.`,
      primary: { label: 'Generate Repair Plan', command: 'resolveit.generateRepairPlan', enabled: true },
      secondary: [
        { label: 'Review Problems', command: 'resolveit.reviewProblems' },
        { label: 'Continue Without AI', command: 'resolveit.reviewProblems' },
      ],
      counts,
      plan,
      showProgress: false,
    };
  }

  return {
    kind: 'PROBLEMS_FOUND',
    title: `${snapshot.blockingCount} issue${snapshot.blockingCount === 1 ? '' : 's'} found`,
    description: 'Deterministic ResolveIt diagnostics found repairable issues. AI planning is unavailable; the findings below remain fully usable.',
    primary: { label: 'Review Problems', command: 'resolveit.reviewProblems', enabled: true },
    secondary: [{ label: 'Retry AI', command: 'resolveit.retryAI' }],
    counts,
    plan,
    showProgress: false,
  };
}

export function approvalLabel(state: ApprovalState): string {
  switch (state) {
    case 'approved':
      return 'Approved';
    case 'denied':
      return 'Skipped';
    default:
      return 'Awaiting approval';
  }
}
