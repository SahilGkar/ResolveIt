import { describe, it, expect } from 'vitest';
import { DEFAULT_PERMISSION_POLICY, getActionRiskLevel, checkPermission, PermissionManagerImpl } from '../src/safety/permission.js';
import { RepairAction, RepairActionType, RiskLevel, ApprovalResult } from '../src/core/interfaces.js';

describe('safety/permission', () => {
  it('should have default policy', () => {
    expect(DEFAULT_PERMISSION_POLICY).toBeDefined();
    expect(DEFAULT_PERMISSION_POLICY.readOnlyActions).toContain('inspect-files');
    expect(DEFAULT_PERMISSION_POLICY.projectModificationActions).toContain('install-dependency');
    expect(DEFAULT_PERMISSION_POLICY.systemModificationActions).toContain('install-tool');
  });

  it('should return read-only for inspect actions', () => {
    expect(getActionRiskLevel('install-dependency')).toBe('project-modification');
    expect(getActionRiskLevel('update-manifest')).toBe('project-modification');
    expect(getActionRiskLevel('create-environment')).toBe('project-modification');
    expect(getActionRiskLevel('modify-configuration')).toBe('project-modification');
    expect(getActionRiskLevel('run-script')).toBe('project-modification');
  });

  it('should return system-modification for system actions', () => {
    expect(getActionRiskLevel('install-tool')).toBe('system-modification');
    expect(getActionRiskLevel('upgrade-runtime')).toBe('system-modification');
    expect(getActionRiskLevel('apply-patch')).toBe('system-modification');
  });

  it('should return read-only for unknown actions', () => {
    expect(getActionRiskLevel('custom' as RepairActionType)).toBe('read-only');
  });

  it('should check permission for read-only actions', () => {
    const action: RepairAction = {
      id: 'action-1',
      type: 'custom',
      description: 'Test',
      target: {},
      payload: {},
      riskLevel: 'read-only',
      prerequisites: [],
    };
    expect(checkPermission(action)).toBe('allowed');
  });

  it('should check permission for project-modification actions', () => {
    const action: RepairAction = {
      id: 'action-1',
      type: 'install-dependency',
      description: 'Test',
      target: {},
      payload: {},
      riskLevel: 'project-modification',
      prerequisites: [],
    };
    expect(checkPermission(action)).toBe('requires-approval');
  });

  it('should check permission for system-modification actions', () => {
    const action: RepairAction = {
      id: 'action-1',
      type: 'install-tool',
      description: 'Test',
      target: {},
      payload: {},
      riskLevel: 'system-modification',
      prerequisites: [],
    };
    expect(checkPermission(action)).toBe('requires-approval');
  });

  it('should create PermissionManagerImpl', () => {
    const manager = new PermissionManagerImpl();
    expect(manager.getPolicy()).toEqual(DEFAULT_PERMISSION_POLICY);
  });

  it('should update policy', () => {
    const manager = new PermissionManagerImpl();
    manager.updatePolicy({ autoApproveReadOnly: false });
    expect(manager.getPolicy().autoApproveReadOnly).toBe(false);
  });

  it('should cache decisions', () => {
    const manager = new PermissionManagerImpl();
    const action: RepairAction = {
      id: 'action-1',
      type: 'install-dependency',
      description: 'Test',
      target: {},
      payload: {},
      riskLevel: 'project-modification',
      prerequisites: [],
    };
    const first = manager.checkPermission(action);
    const second = manager.checkPermission(action);
    expect(first).toBe(second);
  });

  it('should clear cache', () => {
    const manager = new PermissionManagerImpl();
    manager.clearCache();
    expect(manager.getPolicy()).toEqual(DEFAULT_PERMISSION_POLICY);
  });

  it('should request approval for read-only (auto-approve)', async () => {
    const manager = new PermissionManagerImpl();
    const action: RepairAction = {
      id: 'action-1',
      type: 'custom',
      description: 'Test',
      target: {},
      payload: {},
      riskLevel: 'read-only',
      prerequisites: [],
    };
    const result = await manager.requestApproval(action, 'test');
    expect(result.approved).toBe(true);
  });

  it('should request approval for project-modification', async () => {
    const manager = new PermissionManagerImpl();
    const action: RepairAction = {
      id: 'action-1',
      type: 'install-dependency',
      description: 'Test',
      target: {},
      payload: {},
      riskLevel: 'project-modification',
      prerequisites: [],
    };
    const result = await manager.requestApproval(action, 'test');
    expect(result.approved).toBe(false);
    expect(result.rejectedActions).toContain('action-1');
  });

  it('should request approval for system-modification', async () => {
    const manager = new PermissionManagerImpl();
    const action: RepairAction = {
      id: 'action-1',
      type: 'install-tool',
      description: 'Test',
      target: {},
      payload: {},
      riskLevel: 'system-modification',
      prerequisites: [],
    };
    const result = await manager.requestApproval(action, 'test');
    expect(result.approved).toBe(false);
    expect(result.rejectedActions).toContain('action-1');
  });

  it('should record decision', () => {
    const manager = new PermissionManagerImpl();
    manager.recordDecision('action-1', 'allowed');
  });
});