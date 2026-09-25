import type { AIProvider } from '../core/interfaces.js';
import type { AIConfig } from './config.js';
import type { FetchImpl } from './http.js';
import { NoAIProvider } from './providers.js';
import { ExternalAIProvider } from './providers/external.js';
import { LocalAIProvider } from './providers/local.js';

export function createAIProviderFromConfig(config: AIConfig, fetchImpl?: FetchImpl): AIProvider {
  switch (config.provider) {
    case 'local':
      return new LocalAIProvider(config, { fetchImpl });
    case 'external':
      return new ExternalAIProvider(config, { fetchImpl });
    case 'none':
    default:
      return new NoAIProvider();
  }
}
