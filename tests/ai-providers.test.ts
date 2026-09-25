import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  NoAIProvider,
  createAIProviderFromConfig,
  resolveAIConfig,
  sanitizeAIConfig,
  normalizeAIProviderType,
  DEFAULT_AI_TIMEOUT_MS,
  DEFAULT_LOCAL_BASE_URL,
  LocalAIProvider,
  ExternalAIProvider,
  AIProviderError,
  buildAIPlanningContext,
  describeAvailableTools,
  buildPlanningPrompt,
  parseAIPlanningResponse,
  validateAIAction,
  validateAIPlan,
} from '../src/ai/index.js';
import type { FetchImpl } from '../src/ai/index.js';
import type { AIPlanningContext } from '../src/core/models.js';

const ENV_KEYS = [
  'RESOLVEIT_AI_PROVIDER',
  'RESOLVEIT_AI_MODEL',
  'RESOLVEIT_AI_BASE_URL',
  'RESOLVEIT_AI_API_KEY',
  'RESOLVEIT_AI_TIMEOUT_MS',
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

function jsonFetch(status: number, body: unknown): FetchImpl {
  return () => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });
}

function textFetch(status: number, text: string): FetchImpl {
  return () => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) });
}

function minimalContext(): AIPlanningContext {
  return {
    workspaceSummary: { rootPath: '/tmp/ws', projectCount: 0, projects: [], languages: [] },
    environmentSummary: { runtimes: [], tools: [], dockerAvailable: false, dockerRunning: false },
    requirements: [],
    diagnostics: [],
    availableTools: describeAvailableTools(),
    constraints: {
      maxRiskLevel: 'project-modification',
      allowedActions: ['install-dependency'],
      systemModificationRequiresApproval: true,
    },
    previousAttempts: [],
  };
}

describe('AI configuration', () => {
  it('should default to no AI without keys or setup', () => {
    const config = resolveAIConfig();
    expect(config.provider).toBe('none');
    expect(config.apiKey).toBeUndefined();
    expect(config.timeoutMs).toBe(DEFAULT_AI_TIMEOUT_MS);
  });

  it('should read provider, model, URL, key, and timeout from the environment', () => {
    process.env['RESOLVEIT_AI_PROVIDER'] = 'external';
    process.env['RESOLVEIT_AI_MODEL'] = 'env-model';
    process.env['RESOLVEIT_AI_BASE_URL'] = 'https://env.example/v1';
    process.env['RESOLVEIT_AI_API_KEY'] = 'env-key';
    process.env['RESOLVEIT_AI_TIMEOUT_MS'] = '4321';
    const config = resolveAIConfig();
    expect(config.provider).toBe('external');
    expect(config.model).toBe('env-model');
    expect(config.baseUrl).toBe('https://env.example/v1');
    expect(config.apiKey).toBe('env-key');
    expect(config.timeoutMs).toBe(4321);
  });

  it('should prefer explicit overrides over environment variables', () => {
    process.env['RESOLVEIT_AI_PROVIDER'] = 'external';
    process.env['RESOLVEIT_AI_MODEL'] = 'env-model';
    const config = resolveAIConfig({ provider: 'local', model: 'cli-model' });
    expect(config.provider).toBe('local');
    expect(config.model).toBe('cli-model');
  });

  it('should fall back to none for unknown provider values', () => {
    expect(normalizeAIProviderType('skynet')).toBe('none');
    process.env['RESOLVEIT_AI_PROVIDER'] = 'skynet';
    expect(resolveAIConfig().provider).toBe('none');
  });

  it('should ignore invalid timeout values', () => {
    process.env['RESOLVEIT_AI_TIMEOUT_MS'] = 'not-a-number';
    expect(resolveAIConfig().timeoutMs).toBe(DEFAULT_AI_TIMEOUT_MS);
  });

  it('should default the local base URL when unconfigured', () => {
    const config = resolveAIConfig({ provider: 'local' });
    expect(config.baseUrl).toBe(DEFAULT_LOCAL_BASE_URL);
  });

  it('should never expose the API key when sanitized', () => {
    const sanitized = sanitizeAIConfig({
      provider: 'external',
      model: 'm',
      baseUrl: 'https://x.example/v1',
      apiKey: 'super-secret-key',
      timeoutMs: 1000,
    });
    expect(sanitized.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(sanitized)).not.toContain('super-secret-key');
  });
});

describe('AI provider factory', () => {
  it('should create NoAIProvider for none', () => {
    expect(createAIProviderFromConfig({ provider: 'none' })).toBeInstanceOf(NoAIProvider);
  });

  it('should create LocalAIProvider for local', () => {
    expect(createAIProviderFromConfig({ provider: 'local', model: 'qwen' })).toBeInstanceOf(LocalAIProvider);
  });

  it('should create ExternalAIProvider for external', () => {
    expect(createAIProviderFromConfig({ provider: 'external' })).toBeInstanceOf(ExternalAIProvider);
  });

  it('should fall back to NoAIProvider for unknown types', () => {
    expect(createAIProviderFromConfig({ provider: 'unknown' as never })).toBeInstanceOf(NoAIProvider);
  });

  it('should leave NoAIProvider without structured planning', () => {
    expect(typeof new NoAIProvider().generatePlan).toBe('undefined');
  });
});

describe('local AI provider', () => {
  it('should generate a plan from a structured Ollama response', async () => {
    let seenUrl = '';
    let seenBody: Record<string, unknown> = {};
    const fetchImpl: FetchImpl = (url, options) => {
      seenUrl = url;
      seenBody = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              message: {
                content: JSON.stringify({
                  summary: 'Install lodash',
                  actions: [{ type: 'install-dependency', parameters: { ecosystem: 'npm', package: 'lodash' } }],
                }),
              },
            })
          ),
      });
    };
    const provider = new LocalAIProvider(
      { provider: 'local', model: 'custom-model', baseUrl: 'http://localhost:11434', timeoutMs: 5000 },
      { fetchImpl }
    );
    const result = await provider.generatePlan(minimalContext());
    expect(result.summary).toBe('Install lodash');
    expect(result.actions).toHaveLength(1);
    expect(seenUrl).toBe('http://localhost:11434/api/chat');
    expect(seenBody['model']).toBe('custom-model');
    expect(seenBody['stream']).toBe(false);
    expect(seenBody['format']).toBe('json');
  });

  it('should report availability from the tags endpoint', async () => {
    const up = new LocalAIProvider({ provider: 'local', model: 'm' }, { fetchImpl: jsonFetch(200, { models: [] }) });
    const down = new LocalAIProvider({ provider: 'local', model: 'm' }, { fetchImpl: jsonFetch(500, {}) });
    const unreachable = new LocalAIProvider(
      { provider: 'local', model: 'm' },
      {
        fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
      }
    );
    expect(await up.isAvailable()).toBe(true);
    expect(await down.isAvailable()).toBe(false);
    expect(await unreachable.isAvailable()).toBe(false);
  });

  it('should refuse to plan without a configured model and make no requests', async () => {
    let calls = 0;
    const provider = new LocalAIProvider(
      { provider: 'local' },
      {
        fetchImpl: () => {
          calls += 1;
          return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') });
        },
      }
    );
    await expect(provider.generatePlan(minimalContext())).rejects.toMatchObject({ code: 'not-configured' });
    expect(calls).toBe(0);
  });

  it('should surface timeouts without crashing', async () => {
    const hanging: FetchImpl = (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    const provider = new LocalAIProvider({ provider: 'local', model: 'm', timeoutMs: 20 }, { fetchImpl: hanging });
    await expect(provider.generatePlan(minimalContext())).rejects.toMatchObject({ code: 'timeout' });
  });

  it('should reject invalid JSON payloads', async () => {
    const provider = new LocalAIProvider(
      { provider: 'local', model: 'm' },
      { fetchImpl: jsonFetch(200, { message: { content: 'not json{{{' } }) }
    );
    await expect(provider.generatePlan(minimalContext())).rejects.toMatchObject({ code: 'malformed' });
  });

  it('should map server errors to error codes', async () => {
    const provider = new LocalAIProvider(
      { provider: 'local', model: 'm' },
      { fetchImpl: textFetch(500, 'boom') }
    );
    await expect(provider.generatePlan(minimalContext())).rejects.toMatchObject({ code: 'network' });
  });
});

describe('external AI provider', () => {
  const base = { provider: 'external' as const, model: 'ext-model', baseUrl: 'https://api.example/v1', apiKey: 'k' };

  function completion(content: string): FetchImpl {
    return jsonFetch(200, { choices: [{ message: { content } }] });
  }

  it('should generate a plan through an OpenAI-compatible endpoint', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    let seenBody: Record<string, unknown> = {};
    const fetchImpl: FetchImpl = (url, options) => {
      seenUrl = url;
      seenHeaders = options?.headers ?? {};
      seenBody = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Create file',
                      actions: [{ type: 'create-file', parameters: { path: 'a.txt', content: 'x' } }],
                    }),
                  },
                },
              ],
            })
          ),
      });
    };
    const provider = new ExternalAIProvider(base, { fetchImpl });
    const result = await provider.generatePlan(minimalContext());
    expect(result.actions).toHaveLength(1);
    expect(seenUrl).toBe('https://api.example/v1/chat/completions');
    expect(seenHeaders['authorization']).toBe('Bearer k');
    expect(seenBody['model']).toBe('ext-model');
  });

  it('should map authentication failures', async () => {
    const provider = new ExternalAIProvider(base, { fetchImpl: textFetch(401, 'nope') });
    await expect(provider.generatePlan(minimalContext())).rejects.toMatchObject({ code: 'auth' });
  });

  it('should map rate limits', async () => {
    const provider = new ExternalAIProvider(base, { fetchImpl: textFetch(429, 'slow down') });
    await expect(provider.generatePlan(minimalContext())).rejects.toMatchObject({ code: 'rate-limit' });
  });

  it('should surface model refusals', async () => {
    const provider = new ExternalAIProvider(
      base,
      { fetchImpl: jsonFetch(200, { choices: [{ message: { refusal: 'I cannot help' } }] }) }
    );
    await expect(provider.generatePlan(minimalContext())).rejects.toMatchObject({ code: 'refusal' });
  });

  it('should reject invalid JSON envelopes', async () => {
    const provider = new ExternalAIProvider(base, { fetchImpl: textFetch(200, 'not json') });
    await expect(provider.generatePlan(minimalContext())).rejects.toMatchObject({ code: 'malformed' });
  });

  it('should require configuration before any request', async () => {
    let calls = 0;
    const counting: FetchImpl = () => {
      calls += 1;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    };
    const noKey = new ExternalAIProvider({ ...base, apiKey: undefined }, { fetchImpl: counting });
    await expect(noKey.generatePlan(minimalContext())).rejects.toMatchObject({ code: 'not-configured' });
    const noUrl = new ExternalAIProvider({ ...base, baseUrl: undefined }, { fetchImpl: counting });
    await expect(noUrl.generatePlan(minimalContext())).rejects.toMatchObject({ code: 'not-configured' });
    const noModel = new ExternalAIProvider({ ...base, model: undefined }, { fetchImpl: counting });
    await expect(noModel.generatePlan(minimalContext())).rejects.toMatchObject({ code: 'not-configured' });
    expect(calls).toBe(0);
  });

  it('should report unavailable without credentials or on auth failure', async () => {
    const noKey = new ExternalAIProvider({ ...base, apiKey: undefined });
    expect(await noKey.isAvailable()).toBe(false);
    const denied = new ExternalAIProvider(base, { fetchImpl: textFetch(401, 'denied') });
    expect(await denied.isAvailable()).toBe(false);
    const ok = new ExternalAIProvider(base, { fetchImpl: jsonFetch(200, { data: [] }) });
    expect(await ok.isAvailable()).toBe(true);
  });

  it('should use the configured model without hard-coding vendors', async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl: FetchImpl = (_url, options) => {
      seenBody = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 's', actions: [] }) } }] })
          ),
      });
    };
    const provider = new ExternalAIProvider({ ...base, model: 'totally-custom-model' }, { fetchImpl });
    await provider.generatePlan(minimalContext());
    expect(seenBody['model']).toBe('totally-custom-model');
  });
});

describe('AI planning context', () => {
  it('should include structured evidence while excluding secrets and file contents', () => {
    process.env['RESOLVEIT_AI_API_KEY'] = 'env-super-secret';
    const context = buildAIPlanningContext({
      observation: {
        workspace: {
          id: 'ws',
          rootPath: '/tmp/ws',
          projects: [{ id: 'p', name: 'demo', rootPath: '/tmp/ws', type: 'npm' } as never],
          environments: [],
          allFiles: [],
          allDirectories: [],
          languages: [{ id: 'ts', name: 'TypeScript', ecosystems: [] }],
          projectMarkers: [],
          configFiles: [],
          repoIndicators: [],
          errors: [],
        },
        environment: {
          os: { platform: 'linux', architecture: 'x64', hostname: 'h' },
          runtimes: [{ name: 'node', command: 'node', version: '20.0.0', available: true }],
          devTools: [],
          packageManagers: [],
          containers: {
            docker: { name: 'docker', command: 'docker', available: false },
            dockerCompose: { name: 'docker-compose', command: 'docker-compose', available: false },
            dockerRunning: false,
          },
          environmentVariables: { API_KEY: 'env-super-secret', PATH: '/usr/bin' },
          scannedAt: new Date(),
        },
        requirements: [
          {
            projectId: 'p',
            sourceFiles: ['package.json'],
            requirements: [
              {
                id: 'r',
                ecosystem: 'node',
                type: 'runtime-version',
                name: 'node',
                versionConstraint: '>=18',
                sourceFile: 'package.json',
              },
            ],
            parseErrors: [],
          },
        ],
        timestamp: new Date(),
      },
      analysis: {
        observation: {} as never,
        diagnostics: [],
        blockingDiagnostics: [
          {
            id: 'd',
            code: 'RUNTIME_X',
            severity: 'error',
            category: 'runtime',
            title: 'node version mismatch',
            message: 'mismatch',
            evidence: [{ source: 'environment', description: 'node', expected: '>=18', actual: '16' }],
            affectedFiles: ['package.json'],
            source: 'dependency-resolver',
            timestamp: new Date(),
            metadata: {},
          },
        ],
        timestamp: new Date(),
      },
      workspaceRoot: '/tmp/ws',
      failedFingerprints: new Set(['fp-1']),
      lastReport: { success: false, diagnostics: [], resolvedDiagnostics: [], remainingDiagnostics: ['k'], evidence: [], summary: 'nope' },
    });

    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain('env-super-secret');
    expect(context.diagnostics).toHaveLength(1);
    expect(context.diagnostics[0]?.expected).toBe('>=18');
    expect(context.diagnostics[0]?.actual).toBe('16');
    expect(context.requirements).toHaveLength(1);
    expect(context.environmentSummary.runtimes).toHaveLength(1);
    expect(context.availableTools.map((t) => t.name)).toEqual([
      'create-file',
      'modify-file',
      'install-dependency',
      'create-python-venv',
    ]);
    expect(context.previousAttempts).toEqual([{ actionFingerprint: 'fp-1', actionType: 'unknown', success: false }]);
    expect(context.verification?.remainingDiagnostics).toEqual(['k']);
    expect(context.constraints.systemModificationRequiresApproval).toBe(true);
  });

  it('should describe tools without shell access or secrets', () => {
    const serialized = JSON.stringify(describeAvailableTools());
    expect(serialized).not.toMatch(/shell|apiKey|secret|token/i);
    for (const tool of describeAvailableTools()) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(Array.isArray(tool.allowedParameters)).toBe(true);
    }
  });
});

describe('planning prompt', () => {
  it('should state the safety boundary and never include secrets', () => {
    process.env['RESOLVEIT_AI_API_KEY'] = 'prompt-secret';
    const prompt = buildPlanningPrompt(minimalContext());
    expect(prompt.system).toContain('You are proposing actions.');
    expect(prompt.system).toContain('You are not executing actions.');
    expect(prompt.system).toContain('You cannot grant yourself permission.');
    expect(prompt.system).toContain('Only registered ResolveIt RepairTools may execute actions.');
    expect(prompt.system).toContain('create-file');
    expect(JSON.stringify(prompt)).not.toContain('prompt-secret');
  });
});

describe('AI response parsing', () => {
  it('should parse plain and fenced JSON', () => {
    const plain = parseAIPlanningResponse('{"summary":"s","actions":[{"type":"install-dependency","parameters":{"ecosystem":"npm","package":"x"}}]}');
    expect(plain.actions).toHaveLength(1);
    const fenced = parseAIPlanningResponse('```json\n{"summary":"s","confidence":0.5,"actions":[]}\n```');
    expect(fenced.confidence).toBe(0.5);
  });

  it.each(['', '   ', 'not json', '[1,2]', '{"actions":[]}'])('should reject %j', (text) => {
    expect(() => parseAIPlanningResponse(text)).toThrow(AIProviderError);
  });

  it('should reject malformed actions and confidence', () => {
    expect(() => parseAIPlanningResponse('{"summary":"s","actions":[{"parameters":{}}]}')).toThrow('without a type');
    expect(() => parseAIPlanningResponse('{"summary":"s","actions":[{"type":"x"}]}')).toThrow('parameters object');
    expect(() => parseAIPlanningResponse('{"summary":"s","confidence":2,"actions":[]}')).toThrow('confidence');
  });
});

describe('AI plan validation', () => {
  it('should accept a valid install action with tool-owned permission', () => {
    const outcome = validateAIAction(
      { type: 'install-dependency', parameters: { ecosystem: 'npm', package: 'lodash', version: '^4.0.0' } },
      '/tmp/ws',
      'action-1'
    );
    expect('rejection' in outcome).toBe(false);
    if (!('rejection' in outcome)) {
      expect(outcome.action.permissionLevel).toBe('project-modification');
      expect(outcome.action.riskLevel).toBe('project-modification');
      expect((outcome.action.parameters as Record<string, unknown>)['workspaceRoot']).toBe('/tmp/ws');
    }
  });

  it('should resolve tool names to primary action types', () => {
    const outcome = validateAIAction(
      { type: 'create-file', parameters: { path: 'a.txt', content: 'x' } },
      '/tmp/ws',
      'action-1'
    );
    expect('rejection' in outcome).toBe(false);
    if (!('rejection' in outcome)) {
      expect(outcome.toolName).toBe('create-file');
      expect(outcome.action.type).toBe('create-environment');
    }
  });

  it.each(['unknown-tool', 'run-shell', 'install-runtime'])('should reject unknown tool %s', (type) => {
    const outcome = validateAIAction({ type, parameters: {} }, '/tmp/ws', 'action-1');
    expect('rejection' in outcome).toBe(true);
  });

  it.each(['permissionLevel', 'riskLevel', 'approval', 'bypass'])(
    'should reject privilege key %s as escalation',
    (key) => {
      const outcome = validateAIAction(
        { type: 'install-dependency', parameters: { ecosystem: 'npm', package: 'x', [key]: 'read-only' } },
        '/tmp/ws',
        'action-1'
      );
      expect('rejection' in outcome).toBe(true);
      if ('rejection' in outcome) {
        expect(outcome.rejection).toContain('escalation');
      }
    }
  );

  it.each(['command', 'shell', 'exec', 'script'])('should reject command field %s', (key) => {
    const outcome = validateAIAction(
      { type: 'install-dependency', parameters: { ecosystem: 'npm', package: 'x', [key]: 'rm -rf /' } },
      '/tmp/ws',
      'action-1'
    );
    expect('rejection' in outcome).toBe(true);
    if ('rejection' in outcome) {
      expect(outcome.rejection).toContain('command');
    }
  });

  it('should reject path traversal, bad packages, and stray parameters', () => {
    expect('rejection' in validateAIAction({ type: 'create-file', parameters: { path: '../x', content: 'y' } }, '/tmp/ws', 'a')).toBe(true);
    expect('rejection' in validateAIAction({ type: 'install-dependency', parameters: { ecosystem: 'npm', package: 'a; rm' } }, '/tmp/ws', 'a')).toBe(true);
    expect('rejection' in validateAIAction({ type: 'install-dependency', parameters: { ecosystem: 'npm', package: 'x', extra: 1 } }, '/tmp/ws', 'a')).toBe(true);
  });

  it('should override AI-supplied workspace roots with the run root', () => {
    const outcome = validateAIAction(
      { type: 'create-file', parameters: { path: 'a.txt', content: 'x', workspaceRoot: '/evil' } },
      '/tmp/ws',
      'action-1'
    );
    expect('rejection' in outcome).toBe(false);
    if (!('rejection' in outcome)) {
      expect((outcome.action.parameters as Record<string, unknown>)['workspaceRoot']).toBe('/tmp/ws');
    }
  });

  it('should validate whole plans and collect rejections', () => {
    const result = validateAIPlan(
      [
        { type: 'install-dependency', parameters: { ecosystem: 'npm', package: 'ok-pkg' } },
        { type: 'nope', parameters: {} },
      ],
      '/tmp/ws'
    );
    expect(result.valid).toHaveLength(1);
    expect(result.rejections).toHaveLength(1);
  });
});
