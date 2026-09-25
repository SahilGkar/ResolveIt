import type { AIProviderType } from './providers.js';

export interface AIConfig {
  readonly provider: AIProviderType;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

export const DEFAULT_LOCAL_BASE_URL = 'http://localhost:11434';
export const DEFAULT_AI_TIMEOUT_MS = 30000;

export const DEFAULT_AI_CONFIG: AIConfig = {
  provider: 'none',
  timeoutMs: DEFAULT_AI_TIMEOUT_MS,
};

export function normalizeAIProviderType(value: unknown): AIProviderType {
  if (value === 'none' || value === 'local' || value === 'external') {
    return value;
  }
  return 'none';
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value;
}

function parseTimeoutMs(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

export function resolveAIConfig(overrides: Partial<AIConfig> = {}): AIConfig {
  const provider =
    overrides.provider ??
    normalizeAIProviderType(readEnv('RESOLVEIT_AI_PROVIDER'));

  const model = overrides.model ?? readEnv('RESOLVEIT_AI_MODEL');
  const explicitBaseUrl = overrides.baseUrl ?? readEnv('RESOLVEIT_AI_BASE_URL');
  const baseUrl =
    explicitBaseUrl ?? (provider === 'local' ? DEFAULT_LOCAL_BASE_URL : undefined);
  const apiKey = overrides.apiKey ?? readEnv('RESOLVEIT_AI_API_KEY');
  const timeoutMs =
    overrides.timeoutMs ?? parseTimeoutMs(readEnv('RESOLVEIT_AI_TIMEOUT_MS')) ?? DEFAULT_AI_TIMEOUT_MS;

  const config: AIConfig = { provider, timeoutMs };
  return {
    ...config,
    ...(model === undefined ? {} : { model }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

export interface SanitizedAIConfig {
  readonly provider: AIProviderType;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly apiKeyConfigured: boolean;
  readonly timeoutMs?: number;
}

export function sanitizeAIConfig(config: AIConfig): SanitizedAIConfig {
  return {
    provider: config.provider,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    apiKeyConfigured: config.apiKey !== undefined && config.apiKey !== '',
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  };
}
