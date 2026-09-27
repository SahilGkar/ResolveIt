import type { DashboardSnapshot } from '../dashboard/model.js';

export type HubNodeId = 'analyze' | 'diagnostics' | 'ai-report' | 'apply';

export type HubStatusKind = 'neutral' | 'working' | 'ok' | 'warn' | 'err' | 'info';

export interface HubNode {
  readonly id: HubNodeId;
  readonly label: string;
  readonly sub: string;
  readonly badge?: string;
  readonly enabled: boolean;
  readonly disabledReason?: string;
  readonly command?: string;
  readonly screenTarget?: 'report';
}

export interface HubReportCounts {
  readonly detected: number;
  readonly proposed: number;
  readonly approved: number;
  readonly executed: number;
  readonly verified: number;
}

export interface HubModel {
  readonly centerStatus: string;
  readonly statusKind: HubStatusKind;
  readonly busy: boolean;
  readonly progressMessage?: string;
  readonly nodes: ReadonlyArray<HubNode>;
  readonly hasReport: boolean;
  readonly reportStale: boolean;
  readonly reportCounts?: HubReportCounts;
  readonly aiLine?: string;
  readonly aiAvailable: boolean;
  readonly notice?: string;
}

function analyzeNode(snapshot: DashboardSnapshot, busy: boolean): HubNode {
  if (busy) {
    return {
      id: 'analyze',
      label: 'Analyze Project',
      sub: snapshot.activeOperation?.activity ?? 'Working…',
      badge: '…',
      enabled: false,
      disabledReason: 'ResolveIt is working. Wait for it to finish.',
    };
  }
  if (!snapshot.hasWorkspace) {
    return {
      id: 'analyze',
      label: 'Analyze Project',
      sub: 'Open a folder first',
      enabled: false,
      disabledReason: 'Open a folder workspace first.',
    };
  }
  if (!snapshot.hasScanned) {
    return { id: 'analyze', label: 'Analyze Project', sub: 'Run project checks', enabled: true, command: 'resolveit.analyzeProject' };
  }
  return {
    id: 'analyze',
    label: 'Analyze Project',
    sub: 'Run again',
    badge: snapshot.blockingCount === 0 ? '✓' : undefined,
    enabled: true,
    command: 'resolveit.analyzeProject',
  };
}

function diagnosticsNode(snapshot: DashboardSnapshot, busy: boolean): HubNode {
  if (busy) {
    return {
      id: 'diagnostics',
      label: 'Diagnostics',
      sub: 'Working…',
      enabled: false,
      disabledReason: 'ResolveIt is working. Wait for it to finish.',
    };
  }
  if (!snapshot.hasScanned) {
    return {
      id: 'diagnostics',
      label: 'Diagnostics',
      sub: 'Analyze first',
      enabled: false,
      disabledReason: 'Analyze the project first.',
    };
  }
  if (snapshot.diagnostics.length === 0) {
    return {
      id: 'diagnostics',
      label: 'Diagnostics',
      sub: 'No issues found',
      badge: '✓',
      enabled: true,
      command: 'resolveit.reviewProblems',
    };
  }
  return {
    id: 'diagnostics',
    label: 'Diagnostics',
    sub: `${snapshot.blockingCount} blocking · ${snapshot.diagnostics.length} total`,
    badge: `${snapshot.blockingCount}`,
    enabled: true,
    command: 'resolveit.reviewProblems',
  };
}

function aiReportNode(snapshot: DashboardSnapshot, busy: boolean): HubNode {
  if (busy) {
    return {
      id: 'ai-report',
      label: 'AI Report',
      sub: 'Working…',
      enabled: false,
      disabledReason: 'ResolveIt is working. Wait for it to finish.',
    };
  }
  if (!snapshot.hasScanned) {
    return {
      id: 'ai-report',
      label: 'AI Report',
      sub: 'Analyze first',
      enabled: false,
      disabledReason: 'Analyze the project first.',
    };
  }
  if (snapshot.hasPlan) {
    return {
      id: 'ai-report',
      label: 'Review AI Report',
      sub: `${snapshot.planActionCount} proposed · ${snapshot.planApprovedCount} approved`,
      badge: 'Ready',
      enabled: true,
      screenTarget: 'report',
    };
  }
  const aiSub = snapshot.aiAvailable
    ? `${snapshot.aiProvider ?? 'AI'} · ${snapshot.aiModel ?? 'model'}`
    : 'AI unavailable — plan still works';
  return {
    id: 'ai-report',
    label: 'Prepare AI Report',
    sub: aiSub,
    enabled: true,
    command: 'resolveit.generateRepairPlan',
  };
}

function applyNode(snapshot: DashboardSnapshot, busy: boolean): HubNode {
  const base = { id: 'apply' as const, label: 'Apply Changes' };
  if (busy) {
    return { ...base, sub: 'Working…', enabled: false, disabledReason: 'ResolveIt is working. Wait for it to finish.' };
  }
  if (!snapshot.hasPlan) {
    return { ...base, sub: 'No changes yet', enabled: false, disabledReason: 'Generate a repair plan first.' };
  }
  if (snapshot.planStale) {
    return { ...base, sub: 'Plan stale — prepare again', enabled: false, disabledReason: 'Diagnostics changed. Prepare a fresh report.' };
  }
  if (snapshot.planApprovedCount === 0) {
    return {
      ...base,
      sub: `${snapshot.planActionCount} awaiting review`,
      enabled: false,
      disabledReason: 'Allow at least one action in the report first.',
    };
  }
  return {
    ...base,
    sub: `${snapshot.planApprovedCount} of ${snapshot.planActionCount} approved`,
    badge: `${snapshot.planApprovedCount}`,
    enabled: true,
    command: 'resolveit.applyApprovedRepairs',
  };
}

export function buildHubModel(snapshot: DashboardSnapshot): HubModel {
  const busy = snapshot.activeOperation !== undefined;
  const progressMessage = snapshot.activeOperation?.activity;
  let centerStatus = 'Ready to analyze';
  let statusKind: HubStatusKind = 'neutral';
  let notice: string | undefined;

  if (busy) {
    centerStatus = progressMessage ?? 'Working…';
    statusKind = 'working';
  } else if (snapshot.errorMessage && !snapshot.hasVerification) {
    centerStatus = 'Repair failed';
    statusKind = 'err';
    notice = snapshot.errorMessage;
  } else if (snapshot.hasVerification) {
    if (snapshot.verificationRemaining === 0 && snapshot.verificationResolved > 0) {
      centerStatus = 'Project resolved';
      statusKind = 'ok';
    } else {
      centerStatus = `${snapshot.verificationResolved} resolved · ${snapshot.verificationRemaining} remain`;
      statusKind = 'warn';
    }
  } else if (snapshot.hasExecution && snapshot.executionFailed > 0) {
    centerStatus = 'Repair failed';
    statusKind = 'err';
    notice = `${snapshot.executionFailed} action(s) did not complete. Nothing further ran automatically.`;
  } else if (snapshot.hasPlan && snapshot.planStale) {
    centerStatus = 'Report is stale';
    statusKind = 'warn';
    notice = 'Diagnostics changed since this report was prepared. Prepare a fresh report before applying.';
  } else if (snapshot.hasPlan && snapshot.planApprovedCount > 0) {
    centerStatus = `${snapshot.planApprovedCount} change(s) approved`;
    statusKind = 'info';
  } else if (snapshot.hasPlan) {
    centerStatus = 'AI report ready';
    statusKind = 'info';
  } else if (snapshot.blockingCount > 0) {
    centerStatus = `${snapshot.blockingCount} issue(s) found`;
    statusKind = 'warn';
  } else if (snapshot.hasScanned) {
    centerStatus = 'Project healthy';
    statusKind = 'ok';
  }
  if (!snapshot.hasWorkspace) {
    centerStatus = 'No folder open';
    statusKind = 'neutral';
  }

  const reportCounts: HubReportCounts | undefined = snapshot.hasPlan
    ? {
        detected: snapshot.planActionCount,
        proposed: snapshot.planActionCount,
        approved: snapshot.planApprovedCount,
        executed: snapshot.executionSucceeded,
        verified: snapshot.verificationResolved,
      }
    : undefined;

  const aiLine = snapshot.aiAvailable
    ? `${snapshot.aiProvider ?? 'AI'} · ${snapshot.aiModel ?? 'model'}`
    : undefined;

  return {
    centerStatus,
    statusKind,
    busy,
    progressMessage,
    nodes: [analyzeNode(snapshot, busy), diagnosticsNode(snapshot, busy), aiReportNode(snapshot, busy), applyNode(snapshot, busy)],
    hasReport: snapshot.hasPlan,
    reportStale: snapshot.planStale,
    reportCounts,
    aiLine,
    aiAvailable: snapshot.aiAvailable,
    notice,
  };
}

export function hubNodeById(model: HubModel, id: HubNodeId): HubNode | undefined {
  return model.nodes.find((node) => node.id === id);
}
