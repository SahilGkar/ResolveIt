export { NoAIProvider, createAIProvider, AI_PROVIDER_TYPES } from './providers.js';
export type { AIProviderConfig, LocalAIConfig, ExternalAIConfig, AIProviderConfigUnion, AIProviderType } from './providers.js';

export {
  resolveAIConfig,
  sanitizeAIConfig,
  normalizeAIProviderType,
  DEFAULT_AI_CONFIG,
  DEFAULT_AI_TIMEOUT_MS,
  DEFAULT_LOCAL_BASE_URL,
} from './config.js';
export type { AIConfig, SanitizedAIConfig } from './config.js';

export { AIProviderError, isAIProviderError } from './errors.js';
export type { AIErrorCode } from './errors.js';

export { buildAIPlanningContext, describeAvailableTools, toolNameForActionType, TOOL_PARAMETER_ALLOWLIST } from './context.js';
export type { AIContextInput } from './context.js';

export { buildPlanningPrompt } from './prompt.js';
export type { PlanningPrompt } from './prompt.js';

export { parseAIPlanningResponse } from './response.js';

export { validateAIAction, validateAIPlan } from './validation.js';
export type { AIValidationInput, AIValidationResult, ValidatedAIAction } from './validation.js';

export { LocalAIProvider } from './providers/local.js';
export type { LocalProviderOptions } from './providers/local.js';

export { ExternalAIProvider } from './providers/external.js';
export type { ExternalProviderOptions } from './providers/external.js';

export { createAIProviderFromConfig } from './factory.js';

export type { FetchImpl } from './http.js';
