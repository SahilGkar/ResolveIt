import { AIProviderError } from './errors.js';
import type { AIErrorCode } from './errors.js';

export type FetchImpl = (
  url: string,
  options?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export function defaultFetch(): FetchImpl | undefined {
  const globalFetch = (globalThis as { fetch?: unknown }).fetch;
  if (typeof globalFetch !== 'function') {
    return undefined;
  }
  const bound = (globalFetch as typeof fetch).bind(globalThis);
  return (url, options) =>
    bound(url, {
      method: options?.method,
      headers: options?.headers,
      body: options?.body,
      signal: options?.signal,
    }).then((response) => ({
      ok: response.ok,
      status: response.status,
      text: () => response.text(),
    }));
}

export function statusToErrorCode(status: number): AIErrorCode {
  if (status === 401 || status === 403) {
    return 'auth';
  }
  if (status === 429) {
    return 'rate-limit';
  }
  if (status === 404) {
    return 'unavailable';
  }
  if (status >= 500) {
    return 'network';
  }
  return 'invalid';
}

export async function postJson(
  url: string,
  body: unknown,
  options: { headers?: Record<string, string>; timeoutMs: number; fetchImpl?: FetchImpl }
): Promise<{ status: number; text: string }> {
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  if (!fetchImpl) {
    throw new AIProviderError('unavailable', 'No HTTP implementation available for AI provider requests');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, text };
  } catch (err) {
    if (err instanceof AIProviderError) {
      throw err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AIProviderError('timeout', `AI provider request timed out after ${options.timeoutMs}ms`);
    }
    throw new AIProviderError(
      'network',
      `AI provider request failed: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson(
  url: string,
  options: { headers?: Record<string, string>; timeoutMs: number; fetchImpl?: FetchImpl }
): Promise<{ status: number; text: string }> {
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  if (!fetchImpl) {
    throw new AIProviderError('unavailable', 'No HTTP implementation available for AI provider requests');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { ...(options.headers ?? {}) },
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, text };
  } catch (err) {
    if (err instanceof AIProviderError) {
      throw err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AIProviderError('timeout', `AI provider request timed out after ${options.timeoutMs}ms`);
    }
    throw new AIProviderError(
      'network',
      `AI provider request failed: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timer);
  }
}
