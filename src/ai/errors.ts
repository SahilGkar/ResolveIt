export type AIErrorCode =
  | 'unavailable'
  | 'not-configured'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'rate-limit'
  | 'malformed'
  | 'empty'
  | 'refusal'
  | 'invalid';

export class AIProviderError extends Error {
  readonly code: AIErrorCode;

  constructor(code: AIErrorCode, message: string) {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
  }
}

export function isAIProviderError(error: unknown): error is AIProviderError {
  return error instanceof AIProviderError;
}
