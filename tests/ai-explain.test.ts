import { describe, it, expect } from 'vitest';
import {
  buildExplanationContext,
  buildExplanationPrompt,
  parseAIExplanationResponse,
  requestRepairExplanation,
  AIProviderError,
} from '../src/index.js';
import { LocalAIProvider } from '../src/ai/providers/local.js';
import { ExternalAIProvider } from '../src/ai/providers/external.js';
import type { FetchImpl } from '../src/ai/index.js';
import type { AIProvider, Diagnostic, RepairPlan } from '../src/index.js';

function jsonFetch(status: number, body: unknown): FetchImpl {
  return () =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });
}

function missingExpressDiagnostic(): Diagnostic {
  return {
    id: 'diag-1',
    code: 'DEPENDENCY_PACKAGE_MISSING',
    severity: 'error',
    category: 'dependency',
    title: 'Dependency: express',
    message: 'Project requires express ^5.1.0, but it is not currently installed.',
    evidence: [],
    source: 'dependency-resolver',
    timestamp: new Date(),
    metadata: {},
    requirement: {
      id: 'req-1',
      ecosystem: 'node',
      type: 'package-dependency',
      name: 'express',
      versionConstraint: '^5.1.0',
      sourceFile: 'package.json',
    },
  } as Diagnostic;
}

function expressPlan(): RepairPlan {
  return {
    id: 'plan-1',
    name: 'plan',
    description: 'Install missing dependencies',
    actions: [
      {
        id: 'a1',
        type: 'install-dependency',
        permissionLevel: 'project-modification',
        description: 'Install express ^5.1.0',
        target: {},
        parameters: { ecosystem: 'npm', package: 'express', version: '^5.1.0' },
        riskLevel: 'project-modification',
        prerequisites: [],
      },
    ],
    requiresApproval: true,
  };
}

function validExplanationText(): string {
  return JSON.stringify({
    summary: 'One missing dependency needs installing.',
    actions: [
      {
        actionId: 'a1',
        title: 'express',
        whatItMeans: 'A web framework for Node.js.',
        whyDetected: 'Declared but not installed.',
        whatResolveItWillDo: 'Run the safe installer.',
        expectedResult: 'The import resolves.',
        notes: 'Requires network access.',
      },
    ],
    generalNotes: 'Nothing else to do.',
  });
}

describe('AI explanation context', () => {
  it('should carry only safe plan facts with secrets redacted', () => {
    const plan = expressPlan();
    plan.actions[0]!.description = 'Install express ^5.1.0 apiKey: hunter2';
    const context = buildExplanationContext({
      projectName: 'demo',
      workspaceRoot: '/ws',
      plan,
      diagnostics: [missingExpressDiagnostic()],
    });
    expect(context.projectName).toBe('demo');
    expect(context.actions).toHaveLength(1);
    expect(context.actions[0]).toMatchObject({
      actionId: 'a1',
      actionType: 'install-dependency',
      package: 'express',
      ecosystem: 'npm',
      version: '^5.1.0',
    });
    expect(JSON.stringify(context)).not.toContain('hunter2');
    expect(context.actions[0]?.diagnosticMessage).toContain('not currently installed');
  });

  it('should describe the explanation-only prompt with the plan action ids', () => {
    const context = buildExplanationContext({
      projectName: 'demo',
      workspaceRoot: '/ws',
      plan: expressPlan(),
      diagnostics: [missingExpressDiagnostic()],
    });
    const prompt = buildExplanationPrompt(context);
    expect(prompt.user).toContain('a1');
    expect(prompt.user).toContain('express');
    expect(prompt.system).toContain('JSON only');
    expect(prompt.system).toContain('Never add, remove, or rename actions');
  });
});

describe('AI explanation parsing', () => {
  const ids = new Set(['a1']);

  it('should accept a valid explanation', () => {
    const result = parseAIExplanationResponse(validExplanationText(), ids);
    expect(result.summary).toContain('missing dependency');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.actionId).toBe('a1');
    expect(result.generalNotes).toContain('Nothing else');
  });

  it('should reject malformed and empty output, and oversized responses', () => {
    expect(() => parseAIExplanationResponse('not json', ids)).toThrow(AIProviderError);
    expect(() => parseAIExplanationResponse('', ids)).toThrow(AIProviderError);
    expect(() => parseAIExplanationResponse(JSON.stringify({ summary: 'x' }), ids)).toThrow(AIProviderError);
    expect(() => parseAIExplanationResponse('x'.repeat(300 * 1024), ids)).toThrow(AIProviderError);
  });

  it('should truncate overlong fields instead of rendering them raw', () => {
    const result = parseAIExplanationResponse(
      JSON.stringify({
        summary: 'x'.repeat(5000),
        actions: [
          {
            actionId: 'a1',
            title: 't',
            whatItMeans: 'm',
            whyDetected: 'd',
            whatResolveItWillDo: 'w',
            expectedResult: 'e',
          },
        ],
      }),
      ids
    );
    expect(result.summary.length).toBeLessThan(5000);
    expect(result.summary).toContain('[truncated]');
  });

  it('should reject explanations for unknown action ids without touching the plan', () => {
    const hostile = JSON.stringify({
      summary: 'Evil.',
      actions: [
        {
          actionId: 'a-evil',
          title: 'evil',
          whatItMeans: 'x',
          whyDetected: 'x',
          whatResolveItWillDo: 'rm -rf /',
          expectedResult: 'x',
        },
      ],
    });
    expect(() => parseAIExplanationResponse(hostile, ids)).toThrow(/unknown repair action/);
  });

  it('should reject duplicates and incomplete entries', () => {
    const parsed = JSON.parse(validExplanationText()) as { actions: unknown[] };
    const duplicated = JSON.stringify({
      summary: 'x',
      actions: [parsed.actions[0], parsed.actions[0]],
    });
    expect(() => parseAIExplanationResponse(duplicated, ids)).toThrow(/repeats/);
    const incomplete = JSON.stringify({ summary: 'x', actions: [{ actionId: 'a1', title: 't' }] });
    expect(() => parseAIExplanationResponse(incomplete, ids)).toThrow(/missing required fields/);
  });

  it('should reject entries carrying executable content instead of stripping it', () => {
    const withExtras = JSON.stringify({
      summary: 's',
      actions: [
        {
          actionId: 'a1',
          title: 't',
          whatItMeans: 'm',
          whyDetected: 'd',
          whatResolveItWillDo: 'w',
          expectedResult: 'e',
          command: 'rm -rf /',
          shell: 'evil',
        },
      ],
    });
    expect(() => parseAIExplanationResponse(withExtras, ids)).toThrow(/unsupported field/);
  });
});

describe('AI explanation providers', () => {
  const contextOf = () =>
    buildExplanationContext({
      projectName: 'demo',
      workspaceRoot: '/ws',
      plan: expressPlan(),
      diagnostics: [missingExpressDiagnostic()],
    });

  it('should explain via the local provider chat envelope', async () => {
    const provider = new LocalAIProvider(
      { provider: 'local', model: 'm' },
      { fetchImpl: jsonFetch(200, { message: { content: validExplanationText() } }) }
    );
    const result = await provider.explainPlan!(contextOf());
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.actionId).toBe('a1');
  });

  it('should surface malformed local output as an error, not a render', async () => {
    const provider = new LocalAIProvider(
      { provider: 'local', model: 'm' },
      { fetchImpl: jsonFetch(200, { message: { content: 'nope' } }) }
    );
    await expect(provider.explainPlan!(contextOf())).rejects.toThrow(AIProviderError);
  });

  it('should explain via the external provider envelope and honor refusals', async () => {
    const provider = new ExternalAIProvider(
      { provider: 'external', model: 'm', baseUrl: 'https://x.example/v1', apiKey: 'k' },
      { fetchImpl: jsonFetch(200, { choices: [{ message: { content: validExplanationText() } }] }) }
    );
    const result = await provider.explainPlan!(contextOf());
    expect(result.summary).toContain('missing dependency');

    const refusing = new ExternalAIProvider(
      { provider: 'external', model: 'm', baseUrl: 'https://x.example/v1', apiKey: 'k' },
      { fetchImpl: jsonFetch(200, { choices: [{ message: { refusal: 'no' } }] }) }
    );
    await expect(refusing.explainPlan!(contextOf())).rejects.toThrow(/refused/);
  });
});

describe('AI explanation orchestration', () => {
  const inputOf = () => ({
    projectName: 'demo',
    workspaceRoot: '/ws',
    plan: expressPlan(),
    diagnostics: [missingExpressDiagnostic()],
  });

  function stubProvider(explainPlan?: AIProvider['explainPlan'], type: AIProvider['type'] = 'external'): AIProvider {
    return {
      type,
      name: 'Stub',
      version: '0.0.1',
      isAvailable: () => Promise.resolve(true),
      diagnose: () =>
        Promise.resolve({ id: 'd', summary: 's', rootCauses: [], confidence: 0, timestamp: new Date() }),
      planRepair: () =>
        Promise.resolve({ id: 'p', name: 'n', description: 'd', actions: [], requiresApproval: false }),
      ...(explainPlan === undefined ? {} : { explainPlan }),
    };
  }

  it('should be unavailable without AI, without throwing', async () => {
    const none = stubProvider(undefined, 'none');
    const outcome = await requestRepairExplanation(none, buildExplanationContext(inputOf()));
    expect(outcome.status).toBe('unavailable');
  });

  it('should be unavailable when the provider fails, without throwing', async () => {
    const failing = stubProvider(() => Promise.reject(new Error('down')));
    const outcome = await requestRepairExplanation(failing, buildExplanationContext(inputOf()));
    expect(outcome.status).toBe('unavailable');
    if (outcome.status === 'unavailable') {
      expect(outcome.reason.length).toBeGreaterThan(0);
    }
  });

  it('should return a validated explanation and leave the plan untouched', async () => {
    const snapshot = JSON.stringify(expressPlan());
    const ok = stubProvider(() => Promise.resolve(JSON.parse(validExplanationText())));
    const context = buildExplanationContext(inputOf());
    const outcome = await requestRepairExplanation(ok, context);
    expect(outcome.status).toBe('ready');
    if (outcome.status === 'ready') {
      expect(outcome.explanation.actions[0]?.actionId).toBe('a1');
    }
    expect(JSON.stringify(expressPlan())).toBe(snapshot);
  });

  it('should downgrade an invalid explanation to unavailable', async () => {
    const invalid = stubProvider(() =>
      Promise.resolve({ summary: 'x', actions: [{ actionId: 'nope' }] })
    );
    const outcome = await requestRepairExplanation(invalid, buildExplanationContext(inputOf()));
    expect(outcome.status).toBe('unavailable');
  });

  it('should ground the explanation in exact deterministic facts', () => {
    const context = buildExplanationContext(inputOf());
    expect(context.totalActions).toBe(1);
    expect(context.truncated).toBe(false);
    expect(context.actions).toHaveLength(1);
    expect(context.actions[0]?.packageManager).toBe('npm');
    const prompt = buildExplanationPrompt(context);
    expect(prompt.system).toContain('exactly 1 action(s)');
  });
});

describe('AI explanation exactness', () => {
  function fourActionContext(): { ids: Set<string>; entries: (id: string) => Record<string, string> } {
    const ids = new Set(['a1', 'a2', 'a3', 'a4']);
    const entries = (id: string): Record<string, string> => ({
      actionId: id,
      title: id,
      whatItMeans: 'means',
      whyDetected: 'detected',
      whatResolveItWillDo: 'install it',
      expectedResult: 'resolved',
    });
    return { ids, entries };
  }

  it('should accept an explanation covering exactly four actions', () => {
    const { ids, entries } = fourActionContext();
    const text = JSON.stringify({
      summary: 'Four missing dependencies.',
      actions: [entries('a1'), entries('a2'), entries('a3'), entries('a4')],
    });
    const result = parseAIExplanationResponse(text, ids);
    expect(result.actions.map((a) => a.actionId).sort()).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('should reject an explanation that omits one of four actions', () => {
    const { ids, entries } = fourActionContext();
    const text = JSON.stringify({
      summary: 'Three missing dependencies.',
      actions: [entries('a1'), entries('a2'), entries('a3')],
    });
    expect(() => parseAIExplanationResponse(text, ids)).toThrow(/exactly the repair plan actions/);
  });

  it('should reject an explanation that invents a dependency', () => {
    const { ids, entries } = fourActionContext();
    const text = JSON.stringify({
      summary: 'Four dependencies.',
      actions: [entries('a1'), entries('a2'), entries('a3'), entries('a5')],
    });
    expect(() => parseAIExplanationResponse(text, ids)).toThrow(/unknown repair action/);
  });

  it('should reject entries carrying executable or parameter fields', () => {
    const ids = new Set(['a1']);
    for (const key of ['command', 'shell', 'exec', 'parameters', 'action', 'type', 'approval', 'run']) {
      const text = JSON.stringify({
        summary: 's',
        actions: [
          {
            actionId: 'a1',
            title: 't',
            whatItMeans: 'm',
            whyDetected: 'd',
            whatResolveItWillDo: 'w',
            expectedResult: 'e',
            [key]: 'rm -rf /',
          },
        ],
      });
      expect(() => parseAIExplanationResponse(text, ids), `key ${key}`).toThrow(/unsupported field/);
    }
  });

  it('should refuse to explain a truncated plan', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `a${i}`);
    let called = false;
    const provider = {
      type: 'external',
      name: 'Stub',
      version: '0.0.1',
      isAvailable: () => Promise.resolve(true),
      diagnose: () =>
        Promise.resolve({ id: 'd', summary: 's', rootCauses: [], confidence: 0, timestamp: new Date() }),
      planRepair: () =>
        Promise.resolve({ id: 'p', name: 'n', description: 'd', actions: [], requiresApproval: false }),
      explainPlan: () => {
        called = true;
        return Promise.reject(new Error('must never be called for a truncated plan'));
      },
    } as never;
    const outcome = await requestRepairExplanation(provider, {
      projectName: 'p',
      workspaceRoot: '/ws',
      planDescription: 'big',
      totalActions: 40,
      truncated: true,
      actions: many.slice(0, 32).map((actionId) => ({
        actionId,
        actionType: 'install-dependency',
        description: 'Install x',
      })),
    });
    expect(outcome.status).toBe('unavailable');
    expect(called).toBe(false);
  });
});
