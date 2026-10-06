import { describe, it, expect } from 'vitest';
import {
  actionLines,
  configToAIConfigOverrides,
  describeAgentEvent,
  diagnosticDescription,
  diagnosticDetails,
  diagnosticLabel,
  friendlyError,
  multiRootNotice,
  planSummary,
  severityGroup,
  severityIcon,
  statusTextForActivity,
  statusTextForIssues,
} from '../src/mappers.js';
import { primaryRoot, resolveWorkspace } from '../src/workspace.js';
import { ExtensionState } from '../src/state.js';
import type { Diagnostic } from '../../src/index.js';

function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    id: 'diag-1',
    code: 'X',
    severity: 'error',
    category: 'runtime',
    title: 'Node mismatch',
    message: 'node is wrong',
    evidence: [],
    source: 'dependency-resolver',
    timestamp: new Date(),
    metadata: {},
    ...overrides,
  };
}

describe('severity mapping', () => {
  it('should group severities', () => {
    expect(severityGroup('critical')).toBe('Critical');
    expect(severityGroup('error')).toBe('Errors');
    expect(severityGroup('warning')).toBe('Warnings');
    expect(severityGroup('info')).toBe('Info');
    expect(severityGroup('hint')).toBe('Info');
  });

  it('should map icons', () => {
    expect(severityIcon('critical')).toBe('🔴');
    expect(severityIcon('error')).toBe('🔴');
    expect(severityIcon('warning')).toBe('🟠');
    expect(severityIcon('info')).toBe('🟡');
    expect(severityIcon('hint')).toBe('🟡');
  });
});

describe('diagnostic mapping', () => {
  it('should build labels and descriptions', () => {
    const diag = diagnostic();
    expect(diagnosticLabel(diag)).toContain('Node mismatch');
    expect(diagnosticDescription(diag)).toBe('error · runtime');
  });

  it('should expand evidence, files, and remediation', () => {
    const diag = diagnostic({
      evidence: [
        { source: 'requirement', description: 'node >=18' },
        { source: 'environment', description: 'node 16', expected: '>=18', actual: '16' },
      ],
      affectedFiles: ['package.json'],
      remediationCandidates: [
        { id: 'r', type: 'install-dependency', description: 'Install node', confidence: 1, riskLevel: 'system-modification', payload: {} },
      ],
    });
    const details = diagnosticDetails(diag);
    expect(details[0]).toBe('node is wrong');
    expect(details).toContain('requirement: node >=18');
    expect(details).toContain('environment: node 16 (expected: >=18, actual: 16)');
    expect(details).toContain('File: package.json');
    expect(details).toContain('Suggested: Install node');
  });
});

describe('agent event mapping', () => {
  it('should describe every lifecycle event', () => {
    const types = [
      'observation-started', 'observation-completed', 'analysis-completed', 'plan-created',
      'approval-requested', 'approval-granted', 'approval-denied', 'action-started',
      'action-completed', 'action-failed', 'verification-started', 'verification-completed',
      'replanning', 'resolved', 'failed',
    ];
    for (const type of types) {
      expect(describeAgentEvent(type)).toBeTruthy();
      expect(describeAgentEvent(type)).not.toBe('');
    }
    expect(describeAgentEvent('something-unknown')).toBe('something-unknown');
  });
});

describe('status text', () => {
  it('should render issue counts', () => {
    expect(statusTextForIssues(0)).toContain('ResolveIt');
    expect(statusTextForIssues(1)).toContain('1 issue');
    expect(statusTextForIssues(3)).toContain('3 issues');
  });

  it('should render activity', () => {
    expect(statusTextForActivity('verifying')).toContain('verifying');
  });
});

describe('AI status and configuration mapping', () => {
  it('should map VS Code settings to AI config overrides', () => {
    expect(configToAIConfigOverrides({})).toEqual({});
    expect(
      configToAIConfigOverrides({ provider: 'local', model: 'qwen', baseUrl: 'http://x:11434', timeout: 5000 })
    ).toEqual({ provider: 'local', model: 'qwen', baseUrl: 'http://x:11434', timeoutMs: 5000 });
    expect(configToAIConfigOverrides({ provider: '', model: '  ', timeout: -1 })).toEqual({});
    expect(configToAIConfigOverrides({ timeout: 'fast' })).toEqual({});
  });
});

describe('plan mapping', () => {
  it('should summarize plans and actions', () => {
    expect(planSummary({ actions: [] } as never)).toBe('0 actions');
    expect(planSummary({ actions: [1] } as never)).toBe('1 action');
    const lines = actionLines({
      description: 'Install x',
      type: 'install-dependency',
      permissionLevel: 'project-modification',
      reversible: true,
      affectedFiles: ['package.json'],
      estimatedImpact: 'adds dep',
    } as never);
    expect(lines.join('\n')).toContain('Install x');
    expect(lines.join('\n')).toContain('Permission: project-modification');
  });
});

describe('error handling', () => {
  it('should build friendly messages without stack traces', () => {
    const message = friendlyError('ResolveIt could not scan the workspace', new Error('denied'));
    expect(message).toContain('ResolveIt could not scan the workspace');
    expect(message).toContain('denied');
    expect(message).not.toContain(' at ');
  });

  it('should explain multi-root limitations', () => {
    expect(multiRootNotice(['/a', '/b'])).toContain('multi-root');
    expect(multiRootNotice(['/a', '/b'])).toContain('/a');
  });
});

describe('workspace resolution', () => {
  it('should detect no workspace', () => {
    expect(resolveWorkspace(undefined)).toEqual({ kind: 'none' });
    expect(resolveWorkspace([])).toEqual({ kind: 'none' });
    expect(primaryRoot(resolveWorkspace(undefined))).toBeUndefined();
  });

  it('should resolve a single folder', () => {
    const resolution = resolveWorkspace([{ name: 'p', uri: { fsPath: '/tmp/p' } }]);
    expect(resolution).toEqual({ kind: 'single', root: '/tmp/p' });
    expect(primaryRoot(resolution)).toBe('/tmp/p');
  });

  it('should detect multi-root workspaces', () => {
    const resolution = resolveWorkspace([
      { name: 'a', uri: { fsPath: '/a' } },
      { name: 'b', uri: { fsPath: '/b' } },
    ]);
    expect(resolution.kind).toBe('multi');
    expect(primaryRoot(resolution)).toBe('/a');
  });
});

describe('extension state', () => {
  it('should store diagnostics and count blocking items', () => {
    const state = new ExtensionState();
    const before = state.getRevision();
    state.setDiagnostics([diagnostic(), diagnostic({ id: 'd2', severity: 'warning' })]);
    expect(state.getRevision()).toBeGreaterThan(before);
    expect(state.blockingCount()).toBe(1);
    expect(state.getDiagnosticById('d2')?.severity).toBe('warning');
    expect(state.getDiagnosticById('missing')).toBeUndefined();
  });

  it('should store environment, requirements, project, AI, and run data', () => {
    const state = new ExtensionState();
    state.setEnvironment({} as never);
    state.setRequirements([]);
    state.setProjectName('demo');
    state.setAIStatus({ provider: 'none', model: '-', baseUrl: '-', available: true });
    state.setLastRun({ status: 'resolved', timestamp: new Date(), summary: 'ok' });
    state.setLastVerification({ resolved: ['a'], remaining: [], timestamp: new Date() });
    expect(state.getEnvironment()).toBeDefined();
    expect(state.getProjectName()).toBe('demo');
    expect(state.getAIStatus()?.provider).toBe('none');
    expect(state.getLastRun()?.status).toBe('resolved');
    expect(state.getLastVerification()?.resolved).toEqual(['a']);
  });

  it('should cap stored events', () => {
    const state = new ExtensionState();
    for (let i = 0; i < 205; i++) {
      state.appendEvent({ seq: i, type: 'resolved', runId: 'r', timestamp: new Date(), state: 'resolved' });
    }
    expect(state.getEvents()).toHaveLength(200);
    state.clearRunHistory();
    expect(state.getEvents()).toHaveLength(0);
  });
});
