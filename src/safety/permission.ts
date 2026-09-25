import type { RepairAction, RiskLevel, PermissionDecision } from '../core/models.js';
import type { RepairActionType, PermissionPolicy, ApprovalResult } from '../core/interfaces.js';

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  readOnlyActions: [
    'inspect-files',
    'inspect-environment',
    'inspect-tools',
    'inspect-dependencies',
    'run-safe-diagnostics',
  ],
  projectModificationActions: [
    'install-dependency',
    'update-manifest',
    'create-environment',
    'modify-configuration',
    'run-script',
  ],
  systemModificationActions: [
    'install-tool',
    'upgrade-runtime',
    'install-system-package',
    'modify-system-configuration',
  ],
  autoApproveReadOnly: true,
  requireConfirmationForProjectModification: true,
  requireConfirmationForSystemModification: true,
};

export function getActionRiskLevel(actionType: RepairActionType): RiskLevel {
  const projectModificationActions: ReadonlyArray<RepairActionType> = [
    'install-dependency',
    'update-manifest',
    'create-environment',
    'modify-configuration',
    'run-script',
  ];

  const systemModificationActions: ReadonlyArray<RepairActionType> = [
    'install-tool',
    'upgrade-runtime',
    'apply-patch',
  ];

  if (systemModificationActions.includes(actionType)) {
    return 'system-modification';
  }

  if (projectModificationActions.includes(actionType)) {
    return 'project-modification';
  }

  return 'read-only';
}

export function checkPermission(action: RepairAction, policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY): PermissionDecision {
  const riskLevel = getActionRiskLevel(action.type);

  switch (riskLevel) {
    case 'read-only':
      return policy.autoApproveReadOnly ? 'allowed' : 'requires-approval';
    case 'project-modification':
      return policy.requireConfirmationForProjectModification ? 'requires-approval' : 'allowed';
    case 'system-modification':
      return policy.requireConfirmationForSystemModification ? 'requires-approval' : 'denied';
    default:
      return 'denied';
  }
}

export class PermissionManagerImpl {
  private policy: PermissionPolicy;
  private decisions: Map<string, PermissionDecision> = new Map();

  constructor(policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY) {
    this.policy = policy;
  }

  getPolicy(): PermissionPolicy {
    return { ...this.policy };
  }

  updatePolicy(policy: Partial<PermissionPolicy>): void {
    this.policy = { ...this.policy, ...policy };
  }

  checkPermission(action: RepairAction): PermissionDecision {
    const cached = this.decisions.get(action.id);
    if (cached) {
      return cached;
    }
    const decision = checkPermission(action, this.policy);
    this.decisions.set(action.id, decision);
    return decision;
  }

  requestApproval(action: RepairAction, reason: string): ApprovalResult {
    const decision = this.checkPermission(action);
    
    if (decision === 'allowed') {
      return {
        approved: true,
        approvedActions: [action.id],
        rejectedActions: [],
      };
    }

    if (decision === 'denied') {
      return {
        approved: false,
        approvedActions: [],
        rejectedActions: [action.id],
        reason: 'Action denied by safety policy',
      };
    }

    return {
      approved: false,
      approvedActions: [],
      rejectedActions: [action.id],
      reason: `Action requires user approval: ${reason}`,
    };
  }

  recordDecision(actionId: string, decision: PermissionDecision): void {
    this.decisions.set(actionId, decision);
  }

  clearCache(): void {
    this.decisions.clear();
  }
}