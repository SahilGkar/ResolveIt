import { describe, it, expect, beforeEach } from 'vitest';
import { __reset, __testState } from './vscode-mock.js';
import { requestPlanApproval } from '../src/ui/approval.js';
import type { ApprovalDialogs } from '../src/ui/approval.js';
import { Logger, redactSecrets } from '../src/ui/output.js';
import { showBusy, showIssues, showOk } from '../src/ui/statusBar.js';
import type { StatusBarItemLike } from '../src/ui/statusBar.js';
import { escapeHtml } from '../src/ui/html.js';
import type { RepairPlan } from '../../src/index.js';

beforeEach(() => {
  __reset();
});

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

function fakeDialogs(answers: Array<boolean | undefined>): { dialogs: ApprovalDialogs; asked: string[] } {
  const asked: string[] = [];
  const queue = [...answers];
  return {
    asked,
    dialogs: {
      showPlanMessage: () => Promise.resolve(),
      askAction: (description: string) => {
        asked.push(description);
        return Promise.resolve(queue.shift() ?? false);
      },
    },
  };
}

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

describe('shared html escaping', () => {
  it('should escape every dangerous character', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });
});
