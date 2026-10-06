import { describe, it, expect } from 'vitest';
import { NoAIProvider, createAIProvider, AI_PROVIDER_TYPES } from '../src/ai/providers.js';
import { buildPlanningPrompt } from '../src/ai/prompt.js';
import { AgentEvidence, DiagnosisResult, PlanContext, RepairPlan } from '../src/core/interfaces.js';

describe('AI providers', () => {
  it('should have AI_PROVIDER_TYPES', () => {
    expect(AI_PROVIDER_TYPES).toEqual(['none', 'local', 'external']);
  });

  it('should create NoAIProvider', () => {
    const provider = new NoAIProvider();
    expect(provider.type).toBe('none');
    expect(provider.name).toBe('No AI Provider');
    expect(provider.version).toBe('0.0.1');
  });

  it('should return true for isAvailable on NoAIProvider', async () => {
    const provider = new NoAIProvider();
    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });

  it('should return empty diagnosis from NoAIProvider', async () => {
    const provider = new NoAIProvider();
    const evidence: AgentEvidence = {
      workspace: {} as any,
      diagnostics: [],
      environmentSnapshots: [],
    };
    const result = await provider.diagnose(evidence);
    expect(result.rootCauses).toHaveLength(0);
    expect(result.confidence).toBe(0);
  });

  it('should return empty plan from NoAIProvider', async () => {
    const provider = new NoAIProvider();
    const diagnosis: DiagnosisResult = {
      id: 'diag-1',
      summary: 'Test',
      rootCauses: [],
      confidence: 0,
      timestamp: new Date(),
    };
    const context: PlanContext = {
      workspace: {} as any,
      diagnosis,
      constraints: {
        maxRiskLevel: 'project-modification',
        allowedActions: [],
        requireApproval: false,
      },
    };
    const plan = await provider.planRepair(diagnosis, context);
    expect(plan.actions).toHaveLength(0);
    expect(plan.requiresApproval).toBe(false);
  });

  it('should create NoAIProvider via factory', () => {
    const provider = createAIProvider({ type: 'none', name: 'test', settings: {} });
    expect(provider).toBeInstanceOf(NoAIProvider);
  });

  it('should throw for local AI provider', () => {
    expect(() => createAIProvider({ type: 'local', name: 'test', settings: {} })).toThrow('not implemented in Phase 0');
  });

  it('should throw for external AI provider', () => {
    expect(() => createAIProvider({ type: 'external', name: 'test', settings: {} })).toThrow('not implemented in Phase 0');
  });

  it('should throw for unknown provider type', () => {
    expect(() => createAIProvider({ type: 'unknown' as any, name: 'test', settings: {} })).toThrow('Unknown AI provider type');
  });
});

describe('planning prompt', () => {
  function planningContext(): Parameters<typeof buildPlanningPrompt>[0] {
    return {
      workspaceSummary: { rootPath: '/tmp/ws', projectCount: 1, projects: [], languages: [] },
      environmentSummary: { runtimes: [], tools: [], dockerAvailable: false, dockerRunning: false },
      requirements: [],
      diagnostics: [],
      availableTools: [
        {
          name: 'install-dependency',
          description: 'Install a project dependency',
          allowedParameters: ['ecosystem', 'package', 'version', 'developmentOnly'],
          permissionLevel: 'project-modification',
        },
      ],
      constraints: {
        maxRiskLevel: 'project-modification',
        allowedActions: ['install-dependency'],
        systemModificationRequiresApproval: true,
      },
      previousAttempts: [],
    };
  }

  it('should state exact parameter rules so models do not invent schema', () => {
    const prompt = buildPlanningPrompt(planningContext());
    expect(prompt.system).toContain('npm, pip, cargo, go, composer, bundler');
    expect(prompt.system).toContain('there is no versionConstraint parameter');
    expect(prompt.system).toContain('Only registered ResolveIt RepairTools may execute actions');
  });
});