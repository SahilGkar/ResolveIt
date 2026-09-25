import type { AIPlanningResult, AIProposedAction } from '../core/models.js';
import { AIProviderError } from './errors.js';
import { SECURITY_LIMITS, byteLength } from '../safety/limits.js';

const MAX_PARSE_ACTIONS = 32;

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1] !== undefined) {
    return fence[1].trim();
  }
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseAIPlanningResponse(text: string): AIPlanningResult {
  if (!text || text.trim() === '') {
    throw new AIProviderError('empty', 'AI provider returned an empty response');
  }

  if (byteLength(text) > SECURITY_LIMITS.maxAiResponseBytes) {
    throw new AIProviderError(
      'oversized',
      `AI provider response exceeds maximum size (${SECURITY_LIMITS.maxAiResponseBytes} bytes)`
    );
  }

  const payload = stripMarkdownFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    throw new AIProviderError('malformed', 'AI provider response is not valid JSON');
  }

  if (!isRecord(parsed)) {
    throw new AIProviderError('malformed', 'AI provider response must be a JSON object');
  }

  const summary = parsed['summary'];
  if (typeof summary !== 'string' || summary.trim() === '') {
    throw new AIProviderError('malformed', 'AI provider response is missing a summary');
  }
  if (summary.length > 8192) {
    throw new AIProviderError('oversized', 'AI provider summary exceeds maximum length');
  }

  if (!Array.isArray(parsed['actions'])) {
    throw new AIProviderError('malformed', 'AI provider response is missing an actions array');
  }

  if (parsed['actions'].length > MAX_PARSE_ACTIONS) {
    throw new AIProviderError(
      'oversized',
      `AI provider proposed too many actions (${parsed['actions'].length} > ${MAX_PARSE_ACTIONS})`
    );
  }

  const actions: AIProposedAction[] = [];
  for (const entry of parsed['actions']) {
    if (!isRecord(entry) || typeof entry['type'] !== 'string' || entry['type'].trim() === '') {
      throw new AIProviderError('malformed', 'AI provider proposed an action without a type');
    }
    if (!isRecord(entry['parameters'])) {
      throw new AIProviderError('malformed', `AI action ${entry['type']} is missing a parameters object`);
    }
    if (byteLength(JSON.stringify(entry['parameters'])) > SECURITY_LIMITS.maxAiParameterBytes * 4) {
      throw new AIProviderError('oversized', `AI action ${entry['type']} parameters exceed maximum size`);
    }
    const action: AIProposedAction = {
      type: entry['type'].trim(),
      parameters: entry['parameters'],
    };
    actions.push(
      typeof entry['rationale'] === 'string' && entry['rationale'].trim() !== ''
        ? { ...action, rationale: entry['rationale'].trim().slice(0, 2000) }
        : action
    );
  }

  const result: AIPlanningResult = {
    summary: summary.trim(),
    actions,
  };

  if (typeof parsed['reasoning'] === 'string' && parsed['reasoning'].trim() !== '') {
    return { ...result, reasoning: parsed['reasoning'].trim().slice(0, 8192) };
  }

  if (typeof parsed['confidence'] === 'number') {
    const confidence = parsed['confidence'];
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new AIProviderError('malformed', 'AI provider confidence must be a number between 0 and 1');
    }
    return { ...result, confidence };
  }

  return result;
}
