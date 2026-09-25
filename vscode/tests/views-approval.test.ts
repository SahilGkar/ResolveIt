import { describe, it, expect, beforeEach } from 'vitest';
import { __reset, __testState } from './vscode-mock.js';
import { TreeItemCollapsibleState } from 'vscode';
import { ProjectTreeProvider } from '../src/views/projectTree.js';
import { DiagnosticsTreeProvider } from '../src/views/diagnosticsTree.js';
import { EnvironmentTreeProvider } from '../src/views/environmentTree.js';
import { RequirementsTreeProvider, sectionForRequirement } from '../src/views/requirementsTree.js';
import { ExtensionState } from '../src/state.js';
import { requestPlanApproval } from '../src/ui/approval.js';
import type { ApprovalDialogs } from '../src/ui/approval.js';
import { Logger, redactSecrets } from '../src/ui/output.js';
import { showBusy, showIssues, showOk } from '../src/ui/statusBar.js';
import type { StatusBarItemLike } from '../src/ui/statusBar.js';
import type { Diagnostic, ProjectRequirement, RepairPlan } from '../../src/index.js';

beforeEach(() => {
  __reset();
});

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

function requirement(overrides: Partial<ProjectRequirement> = {}): ProjectRequirement {
  return {
    id: 'req-1',
    ecosystem: 'node',
    type: 'package-dependency',
    name: 'lodash',
    versionConstraint: '^4.0.0',
    sourceFile: 'package.json',
    ...overrides,
  };
}

function planWith(ids: string[]): RepairPlan {
  return {
    id: 'plan-1',
    name: 'Test',
    description: 'Test',
    actions: ids.map((id) => ({
      id,
      type: 'install-dependency',
      permissionLevel: 'project-modification',
      description: `Install ${id}`,
      target: {},
      parameters: {},
      riskLevel: 'project-modification',
      prerequisites: [],
    })),
    requiresApproval: true,
  } as RepairPlan;
}

function fakeDialogs(answers: Array<boolean | undefined>): { dialogs: ApprovalDialogs; asked: string[]; notices: string[] } {
  const asked: string[] = [];
  const notices: string[] = [];
  void notices;
  const queue = [...answers];
  return {
    asked,
    notices,
    dialogs: {
      showPlanMessage: () => Promise.resolve(),
      askAction: (description: string) => {
        asked.push(description);
        return Promise.resolve(queue.shift() ?? false);
      },
    },
  };
}

describe('project tree', () => {
  it('should render sections with live state', () => {
    const state = new ExtensionState();
    state.setProjectName('demo');
    state.setDiagnostics([diagnostic()]);
    state.setAIStatus({ provider: 'none', model: '-', baseUrl: '-', available: true });
    state.setLastRun({ status: 'resolved', timestamp: new Date(), summary: 'ok' });
    const provider = new ProjectTreeProvider(state);

    const roots = provider.getChildren();
    expect(roots.map((node) => (node.kind === 'section' ? node.label : ''))).toEqual([
      'Project',
      'Status',
      'Actions',
      'AI',
      'Last Run',
    ]);

    const project = provider.getChildren({ kind: 'section', label: 'Project' });
    expect(project[0]).toMatchObject({ kind: 'item', label: 'demo' });

    const actions = provider.getChildren({ kind: 'section', label: 'Actions' });
    expect(actions.map((node) => (node.kind === 'item' ? node.commandId : ''))).toEqual([
      'resolveit.scan',
      'resolveit.diagnose',
      'resolveit.run',
    ]);

    const item = provider.getTreeItem(actions[0] as never);
    expect(item.command?.command).toBe('resolveit.scan');
  });
});

describe('diagnostics tree', () => {
  it('should group by severity and expand details', () => {
    const state = new ExtensionState();
    state.setDiagnostics([
      diagnostic(),
      diagnostic({ id: 'd2', severity: 'warning', title: 'Docker missing', affectedFiles: ['compose.yml'] }),
      diagnostic({ id: 'd3', severity: 'info', title: 'Dep unknown' }),
    ]);
    const provider = new DiagnosticsTreeProvider(state, (relative) => `/ws/${relative}`);

    const groups = provider.getChildren();
    expect(groups.map((node) => (node.kind === 'group' ? node.group : ''))).toEqual(['Errors', 'Warnings', 'Info']);

    const errors = provider.getChildren({ kind: 'group', group: 'Errors' });
    expect(errors).toHaveLength(1);
    expect(provider.getTreeItem(errors[0] as never).collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);

    const details = provider.getChildren({ kind: 'group', group: 'Warnings' });
    const expanded = provider.getChildren(details[0] as never);
    expect(expanded.length).toBeGreaterThan(0);
    const fileDetail = provider.getTreeItem(expanded[1] as never);
    expect(fileDetail.command?.command).toBe('vscode.open');
    expect(fileDetail.command?.arguments?.[0]).toMatchObject({ fsPath: '/ws/compose.yml' });
  });

  it('should render nothing without diagnostics', () => {
    const provider = new DiagnosticsTreeProvider(new ExtensionState());
    expect(provider.getChildren()).toEqual([]);
  });
});

describe('environment tree', () => {
  it('should show availability from Phase 2 output', () => {
    const state = new ExtensionState();
    state.setEnvironment({
      runtimes: [{ name: 'node', command: 'node', version: '20.0.0', available: true }],
      devTools: [{ name: 'docker', command: 'docker', available: false }],
      packageManagers: [{ name: 'npm', command: 'npm', version: '10.0.0', available: true }],
      containers: {
        docker: { name: 'docker', command: 'docker', available: false },
        dockerCompose: { name: 'dc', command: 'dc', available: false },
        dockerRunning: false,
      },
    } as never);
    const provider = new EnvironmentTreeProvider(state);
    const sections = provider.getChildren();
    expect(sections.map((node) => (node.kind === 'section' ? node.label : ''))).toEqual([
      'Runtimes',
      'Tools',
      'Package Managers',
      'Containers',
    ]);
    const runtimes = provider.getChildren({ kind: 'section', label: 'Runtimes' });
    expect(runtimes[0]).toMatchObject({ kind: 'item', label: '✓ node' });
    const tools = provider.getChildren({ kind: 'section', label: 'Tools' });
    expect(tools[0]).toMatchObject({ kind: 'item', label: '✗ docker' });
  });

  it('should prompt to run the environment command when empty', () => {
    const provider = new EnvironmentTreeProvider(new ExtensionState());
    expect(provider.getChildren()).toHaveLength(1);
  });
});

describe('requirements tree', () => {
  it('should group requirements by kind', () => {
    expect(sectionForRequirement(requirement())).toBe('Dependencies');
    expect(sectionForRequirement(requirement({ type: 'package-dependency', developmentOnly: true }))).toBe(
      'Development Dependencies'
    );
    expect(sectionForRequirement(requirement({ type: 'runtime-version', name: 'node' }))).toBe('Runtime Requirements');
    expect(sectionForRequirement(requirement({ type: 'container-image', name: 'pg' }))).toBe('Containers');
    expect(sectionForRequirement(requirement({ type: 'custom' as never }))).toBe('Other');
  });

  it('should list grouped requirements with source files', () => {
    const state = new ExtensionState();
    state.setRequirements([
      { projectId: 'p', sourceFiles: ['package.json'], requirements: [requirement()], parseErrors: [] },
    ]);
    const provider = new RequirementsTreeProvider(state, (relative) => `/ws/${relative}`);
    const sections = provider.getChildren();
    expect(sections).toEqual([{ kind: 'section', label: 'Dependencies' }]);
    const items = provider.getChildren({ kind: 'section', label: 'Dependencies' });
    expect(items).toHaveLength(1);
    const rendered = provider.getTreeItem(items[0] as never);
    expect(rendered.label).toContain('lodash');
    expect(rendered.command?.command).toBe('vscode.open');
  });
});

describe('approval dialogs', () => {
  it('should approve nothing for an empty plan', async () => {
    const { dialogs, asked } = fakeDialogs([]);
    const approved = await requestPlanApproval(planWith([]), [], dialogs, () => undefined);
    expect(approved).toEqual([]);
    expect(asked).toHaveLength(0);
  });

  it('should notify manual actions without executing them', async () => {
    const notices: string[] = [];
    const { dialogs } = fakeDialogs([]);
    const approved = await requestPlanApproval(
      planWith([]),
      [{ description: 'Upgrade node by hand', reason: 'system change', riskLevel: 'system-modification', diagnosticKeys: ['k'] }],
      dialogs,
      (message) => notices.push(message)
    );
    expect(approved).toEqual([]);
    expect(notices.join(' ')).toContain('Upgrade node by hand');
  });

  it('should collect per-action decisions in order', async () => {
    const { dialogs, asked } = fakeDialogs([true, false]);
    const approved = await requestPlanApproval(planWith(['a', 'b']), [], dialogs, () => undefined);
    expect(approved).toEqual(['a']);
    expect(asked).toEqual(['Install a', 'Install b']);
  });
});

describe('output channel', () => {
  it('should redact secrets from log lines', () => {
    expect(redactSecrets('apiKey: hunter2')).toContain('[REDACTED_API_KEY]');
    expect(redactSecrets('Authorization Bearer abc123')).toContain('Bearer [REDACTED]');
    expect(redactSecrets('plain message')).toBe('plain message');
  });

  it('should write prefixed lines to the channel', () => {
    const logger = new Logger();
    logger.info('hello');
    logger.warn('careful');
    logger.error('boom');
    expect(__testState.outputLines).toEqual(['hello', 'WARN: careful', 'ERROR: boom']);
  });
});

describe('status bar', () => {
  function item(): StatusBarItemLike & { shown: boolean } {
    return { text: '', tooltip: '', command: undefined, shown: false, show() { this.shown = true; }, dispose() {} };
  }

  it('should reflect issues, activity, and healthy states', () => {
    const issues = item();
    showIssues(issues, 5, 2);
    expect(issues.text).toContain('2 issues');
    expect(issues.command).toBe('resolveit.diagnose');
    expect(issues.shown).toBe(true);

    const busy = item();
    showBusy(busy, 'verifying', 'tip');
    expect(busy.text).toContain('verifying');
    expect(busy.command).toBeUndefined();

    const ok = item();
    showOk(ok, 'ready');
    expect(ok.text).toContain('ResolveIt');
    expect(ok.command).toBe('resolveit.run');
  });
});
