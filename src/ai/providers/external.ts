import type {
  AgentEvidence,
  AIProvider,
  AIPlanningContext,
  AIPlanningResult,
  DiagnosisResult,
  PlanContext,
  RepairPlan,
} from '../../core/interfaces.js';
import type { AIConfig } from '../config.js';
import { DEFAULT_AI_TIMEOUT_MS } from '../config.js';
import { AIProviderError } from '../errors.js';
import { getJson, postJson, statusToErrorCode } from '../http.js';
import type { FetchImpl } from '../http.js';
import { buildPlanningPrompt } from '../prompt.js';
import { parseAIPlanningResponse } from '../response.js';

export interface ExternalProviderOptions {
  readonly fetchImpl?: FetchImpl;
}

export class ExternalAIProvider implements AIProvider {
  readonly type = 'external' as const;
  readonly name = 'External AI Provider';
  readonly version = '0.0.1';

  private readonly model?: string;
  private readonly baseUrl?: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl?: FetchImpl;

  constructor(config: AIConfig, options: ExternalProviderOptions = {}) {
    this.model = config.model;
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl;
  }

  getModel(): string | undefined {
    return this.model;
  }

  getBaseUrl(): string | undefined {
    return this.baseUrl;
  }

  hasApiKey(): boolean {
    return this.apiKey !== undefined && this.apiKey !== '';
  }

  private authHeaders(): Record<string, string> {
    if (!this.hasApiKey()) {
      return {};
    }
    return { authorization: `Bearer ${this.apiKey as string}` };
  }

  async isAvailable(): Promise<boolean> {
    if (!this.baseUrl || !this.hasApiKey()) {
      return false;
    }
    try {
      const { status } = await getJson(`${this.baseUrl}/models`, {
        headers: this.authHeaders(),
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
      });
      return status >= 200 && status < 300;
    } catch {
      return false;
    }
  }

  diagnose(_evidence: AgentEvidence): Promise<DiagnosisResult> {
    return Promise.resolve({
      id: `diagnosis-${Date.now()}`,
      summary: 'External AI diagnosis uses deterministic evidence; AI contributes planning only.',
      rootCauses: [],
      confidence: 0,
      timestamp: new Date(),
    });
  }

  planRepair(_diagnosis: DiagnosisResult, _context: PlanContext): Promise<RepairPlan> {
    return Promise.resolve({
      id: `plan-${Date.now()}`,
      name: 'External AI Plan',
      description: 'Use structured AI planning (generatePlan) instead of the legacy planRepair contract.',
      actions: [],
      requiresApproval: false,
    });
  }

  async generatePlan(context: AIPlanningContext): Promise<AIPlanningResult> {
    if (!this.baseUrl) {
      throw new AIProviderError('not-configured', 'External AI provider has no base URL configured');
    }
    if (!this.model) {
      throw new AIProviderError('not-configured', 'External AI provider has no model configured');
    }
    if (!this.hasApiKey()) {
      throw new AIProviderError('not-configured', 'External AI provider has no API key configured');
    }

    const prompt = buildPlanningPrompt(context);
    let response: { status: number; text: string };
    try {
      response = await postJson(
        `${this.baseUrl}/chat/completions`,
        {
          model: this.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        },
        { headers: this.authHeaders(), timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl }
      );
    } catch (err) {
      if (err instanceof AIProviderError) {
        throw err;
      }
      throw new AIProviderError('network', 'External AI provider request failed');
    }

    if (response.status < 200 || response.status >= 300) {
      throw new AIProviderError(
        statusToErrorCode(response.status),
        `External AI provider responded with status ${response.status}`
      );
    }

    let content: unknown;
    let refusal: unknown;
    try {
      const parsed = JSON.parse(response.text) as {
        choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }>;
      };
      content = parsed.choices?.[0]?.message?.content;
      refusal = parsed.choices?.[0]?.message?.refusal;
    } catch {
      throw new AIProviderError('malformed', 'External AI provider response is not valid JSON');
    }

    if (typeof refusal === 'string' && refusal.trim() !== '') {
      throw new AIProviderError('refusal', 'External AI provider refused the planning request');
    }

    if (typeof content !== 'string') {
      throw new AIProviderError('malformed', 'External AI provider response has no message content');
    }

    return parseAIPlanningResponse(content);
  }
}
