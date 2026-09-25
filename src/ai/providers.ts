import type { AIProvider, AgentEvidence, DiagnosisResult, PlanContext, RepairPlan } from '../core/interfaces.js';

export class NoAIProvider implements AIProvider {
  readonly type = 'none' as const;
  readonly name = 'No AI Provider';
  readonly version = '0.0.1';

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  diagnose(_evidence: AgentEvidence): Promise<DiagnosisResult> {
    return Promise.resolve({
      id: `diagnosis-${Date.now()}`,
      summary: 'No AI provider available. Deterministic diagnostics only.',
      rootCauses: [],
      confidence: 0,
      timestamp: new Date(),
    });
  }

  planRepair(_diagnosis: DiagnosisResult, _context: PlanContext): Promise<RepairPlan> {
    return Promise.resolve({
      id: `plan-${Date.now()}`,
      name: 'No AI Plan',
      description: 'No AI provider available. Manual repair required.',
      actions: [],
      requiresApproval: false,
    });
  }
}

export interface AIProviderConfig {
  type: 'none' | 'local' | 'external';
  name: string;
  settings: Record<string, unknown>;
}

export interface LocalAIConfig extends AIProviderConfig {
  type: 'local';
  settings: {
    modelPath: string;
    contextLength: number;
    temperature: number;
  };
}

export interface ExternalAIConfig extends AIProviderConfig {
  type: 'external';
  settings: {
    endpoint: string;
    model: string;
    apiKeyRef: string;
    timeout: number;
  };
}

export type AIProviderConfigUnion = AIProviderConfig | LocalAIConfig | ExternalAIConfig;

export function createAIProvider(config: AIProviderConfigUnion): AIProvider {
  switch (config.type) {
    case 'none':
      return new NoAIProvider();
    case 'local':
      throw new Error('Local AI provider not implemented in Phase 0');
    case 'external':
      throw new Error('External AI provider not implemented in Phase 0');
    default:
      throw new Error(`Unknown AI provider type: ${(config as AIProviderConfig).type}`);
  }
}

export const AI_PROVIDER_TYPES = ['none', 'local', 'external'] as const;
export type AIProviderType = (typeof AI_PROVIDER_TYPES)[number];