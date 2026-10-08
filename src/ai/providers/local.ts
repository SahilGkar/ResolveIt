import type {
  AgentEvidence,
  AIProvider,
  AIPlanningContext,
  AIPlanningResult,
  AIExplanationContext,
  AIExplanationResult,
  DiagnosisResult,
  PlanContext,
  RepairPlan,
} from '../../core/interfaces.js';
import type { AIConfig } from '../config.js';
import { DEFAULT_AI_TIMEOUT_MS, DEFAULT_LOCAL_BASE_URL } from '../config.js';
import { AIProviderError } from '../errors.js';
import { getJson, postJson, statusToErrorCode } from '../http.js';
import type { FetchImpl } from '../http.js';
import { buildPlanningPrompt } from '../prompt.js';
import { parseAIPlanningResponse } from '../response.js';
import { buildExplanationPrompt, parseAIExplanationResponse } from '../explain.js';

export interface LocalProviderOptions {
  readonly fetchImpl?: FetchImpl;
}

export class LocalAIProvider implements AIProvider {
  readonly type = 'local' as const;
  readonly name = 'Local AI Provider';
  readonly version = '0.0.1';

  private readonly model?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl?: FetchImpl;

  constructor(config: AIConfig, options: LocalProviderOptions = {}) {
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? DEFAULT_LOCAL_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl;
  }

  getModel(): string | undefined {
    return this.model;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { status } = await getJson(`${this.baseUrl}/api/tags`, {
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
      summary: 'Local AI diagnosis uses deterministic evidence; AI contributes planning only.',
      rootCauses: [],
      confidence: 0,
      timestamp: new Date(),
    });
  }

  planRepair(_diagnosis: DiagnosisResult, _context: PlanContext): Promise<RepairPlan> {
    return Promise.resolve({
      id: `plan-${Date.now()}`,
      name: 'Local AI Plan',
      description: 'Use structured AI planning (generatePlan) instead of the legacy planRepair contract.',
      actions: [],
      requiresApproval: false,
    });
  }

  async generatePlan(context: AIPlanningContext): Promise<AIPlanningResult> {
    if (!this.model) {
      throw new AIProviderError('not-configured', 'Local AI provider has no model configured');
    }

    const prompt = buildPlanningPrompt(context);
    let response: { status: number; text: string };
    try {
      response = await postJson(
        `${this.baseUrl}/api/chat`,
        {
          model: this.model,
          stream: false,
          format: 'json',
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        },
        { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl }
      );
    } catch (err) {
      if (err instanceof AIProviderError) {
        throw err;
      }
      throw new AIProviderError('network', 'Local AI provider request failed');
    }

    if (response.status < 200 || response.status >= 300) {
      throw new AIProviderError(
        statusToErrorCode(response.status),
        `Local AI provider responded with status ${response.status}`
      );
    }

    let content: unknown;
    try {
      const parsed = JSON.parse(response.text) as { message?: { content?: unknown } };
      content = parsed.message?.content;
    } catch {
      throw new AIProviderError('malformed', 'Local AI provider response is not valid JSON');
    }

    if (typeof content !== 'string') {
      throw new AIProviderError('malformed', 'Local AI provider response has no message content');
    }

    return parseAIPlanningResponse(content);
  }

  /**
   * Explain an existing deterministic plan. Read-only: the returned text is
   * validated against the plan's action ids by the caller and is only ever
   * rendered as information, never planned from or executed.
   */
  async explainPlan(context: AIExplanationContext): Promise<AIExplanationResult> {
    if (!this.model) {
      throw new AIProviderError('not-configured', 'Local AI provider has no model configured');
    }

    const prompt = buildExplanationPrompt(context);
    let response: { status: number; text: string };
    try {
      response = await postJson(
        `${this.baseUrl}/api/chat`,
        {
          model: this.model,
          stream: false,
          format: 'json',
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        },
        { timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl }
      );
    } catch (err) {
      if (err instanceof AIProviderError) {
        throw err;
      }
      throw new AIProviderError('network', 'Local AI provider request failed');
    }

    if (response.status < 200 || response.status >= 300) {
      throw new AIProviderError(
        statusToErrorCode(response.status),
        `Local AI provider responded with status ${response.status}`
      );
    }

    let content: unknown;
    try {
      const parsed = JSON.parse(response.text) as { message?: { content?: unknown } };
      content = parsed.message?.content;
    } catch {
      throw new AIProviderError('malformed', 'Local AI provider response is not valid JSON');
    }

    if (typeof content !== 'string') {
      throw new AIProviderError('malformed', 'Local AI provider response has no message content');
    }

    const validIds = new Set(context.actions.map((action) => action.actionId));
    return parseAIExplanationResponse(content, validIds);
  }
}
