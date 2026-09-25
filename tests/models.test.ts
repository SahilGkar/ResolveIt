import { describe, it, expect } from 'vitest';
import {
  Project,
  Workspace,
  Environment,
  Diagnostic,
  RepairAction,
  RepairPlan,
  VerificationResult,
  AgentState,
  AgentEvidence,
  DiagnosisResult,
  PlanContext,
  Language,
  Ecosystem,
  Tool,
  Requirement,
  Dependency,
  RiskLevel,
} from '../src/core/models.js';

describe('core models', () => {
  it('should be able to create a Project', () => {
    const project: Project = {
      id: 'proj-1',
      name: 'test-project',
      rootPath: '/tmp/test',
      type: 'npm',
      manifest: {
        path: '/tmp/test/package.json',
        format: 'package.json',
        content: { name: 'test', version: '1.0.0' },
      },
      dependencies: [],
      languages: [],
    };
    expect(project.id).toBe('proj-1');
    expect(project.type).toBe('npm');
  });

  it('should be able to create a Workspace', () => {
    const workspace: Workspace = {
      id: 'ws-1',
      rootPath: '/tmp/workspace',
      projects: [],
      environments: [],
    };
    expect(workspace.id).toBe('ws-1');
  });

  it('should be able to create an Environment', () => {
    const env: Environment = {
      id: 'env-1',
      name: 'local',
      type: 'local',
      runtime: {
        name: 'node',
        version: '20.0.0',
        path: '/usr/bin/node',
        metadata: {},
      },
      tools: [],
      variables: {},
    };
    expect(env.type).toBe('local');
  });

  it('should be able to create a Diagnostic', () => {
    const diag: Diagnostic = {
      id: 'diag-1',
      code: 'MISSING_DEPENDENCY',
      severity: 'error',
      message: 'Missing dependency: lodash',
      source: 'dependency-resolver',
      timestamp: new Date(),
      metadata: {},
    };
    expect(diag.severity).toBe('error');
    expect(diag.source).toBe('dependency-resolver');
  });

  it('should be able to create a RepairAction', () => {
    const action: RepairAction = {
      id: 'action-1',
      type: 'install-dependency',
      description: 'Install lodash',
      target: { projectId: 'proj-1' },
      payload: { name: 'lodash', version: '^4.17.21' },
      riskLevel: 'project-modification',
      prerequisites: [],
    };
    expect(action.type).toBe('install-dependency');
    expect(action.riskLevel).toBe('project-modification');
  });

  it('should be able to create a RepairPlan', () => {
    const plan: RepairPlan = {
      id: 'plan-1',
      name: 'Fix dependencies',
      description: 'Install missing dependencies',
      actions: [],
      requiresApproval: true,
    };
    expect(plan.requiresApproval).toBe(true);
  });

  it('should be able to create a VerificationResult', () => {
    const result: VerificationResult = {
      repairPlanId: 'plan-1',
      actionId: 'action-1',
      success: true,
      diagnostics: [],
      timestamp: new Date(),
      metadata: {},
    };
    expect(result.success).toBe(true);
  });

  it('should be able to create an AgentState', () => {
    const state: AgentState = {
      stage: 'observe',
      workspaceId: 'ws-1',
      evidence: {
        workspace: {} as Workspace,
        diagnostics: [],
        environmentSnapshots: [],
      },
      verificationResults: [],
      startedAt: new Date(),
      updatedAt: new Date(),
    };
    expect(state.stage).toBe('observe');
  });

  it('should be able to create an AgentEvidence', () => {
    const evidence: AgentEvidence = {
      workspace: {} as Workspace,
      diagnostics: [],
      environmentSnapshots: [],
    };
    expect(evidence.diagnostics).toEqual([]);
  });

  it('should be able to create a DiagnosisResult', () => {
    const diagnosis: DiagnosisResult = {
      id: 'diag-1',
      summary: 'Test diagnosis',
      rootCauses: [],
      confidence: 0.9,
      timestamp: new Date(),
    };
    expect(diagnosis.confidence).toBe(0.9);
  });

  it('should be able to create a PlanContext', () => {
    const context: PlanContext = {
      workspace: {} as Workspace,
      diagnosis: {} as DiagnosisResult,
      constraints: {
        maxRiskLevel: 'project-modification',
        allowedActions: ['install-dependency'],
        requireApproval: true,
      },
    };
    expect(context.constraints.maxRiskLevel).toBe('project-modification');
  });

  it('should be able to create a Language', () => {
    const lang: Language = {
      id: 'typescript',
      name: 'TypeScript',
      version: '5.3.0',
      ecosystems: [],
    };
    expect(lang.id).toBe('typescript');
  });

  it('should be able to create an Ecosystem', () => {
    const eco: Ecosystem = {
      id: 'npm',
      name: 'npm',
      packageManagers: [],
    };
    expect(eco.id).toBe('npm');
  });

  it('should be able to create a Tool', () => {
    const tool: Tool = {
      id: 'npm',
      name: 'npm',
      version: '10.0.0',
      path: '/usr/bin/npm',
      capabilities: ['install', 'run'],
    };
    expect(tool.capabilities).toContain('install');
  });

  it('should be able to create a Requirement', () => {
    const req: Requirement = {
      id: 'req-1',
      type: 'runtime-version',
      specifier: '>=20.0.0',
      satisfied: true,
    };
    expect(req.satisfied).toBe(true);
  });

  it('should be able to create a Dependency', () => {
    const dep: Dependency = {
      name: 'lodash',
      version: '4.17.21',
      source: 'registry',
      scope: 'production',
      optional: false,
    };
    expect(dep.source).toBe('registry');
  });

  it('should have all RiskLevel types', () => {
    const levels: RiskLevel[] = ['read-only', 'project-modification', 'system-modification'];
    expect(levels).toHaveLength(3);
  });
});