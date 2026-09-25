import { promises as fs } from 'fs';
import { resolve } from 'path';
import type {
  Diagnostic,
  RepairAction,
  RepairResult,
  VerificationResult,
} from '../core/models.js';
import type {
  VerificationContext,
  VerificationEngine,
  VerificationRule,
} from '../core/interfaces.js';
import { diagnosticKey, isBlockingDiagnostic } from './analysis.js';
import type { AgentAnalysis } from './analysis.js';

export interface VerificationEvidence {
  readonly source: 'diagnostic-rerun' | 'targeted-check';
  readonly description: string;
  readonly actionId?: string;
  readonly passed?: boolean;
}

export interface VerificationReport {
  readonly success: boolean;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly resolvedDiagnostics: ReadonlyArray<string>;
  readonly remainingDiagnostics: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<VerificationEvidence>;
  readonly summary: string;
}

export interface TargetedCheck {
  readonly passed: boolean;
  readonly description: string;
}

function workspaceRootFor(action: RepairAction, fallback: string): string {
  const candidate = (action.parameters as Record<string, unknown>)['workspaceRoot'];
  if (typeof candidate === 'string' && candidate.trim() !== '') {
    return candidate;
  }
  if (action.target.filePath) {
    return action.target.filePath;
  }
  return fallback;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function targetedCheck(
  action: RepairAction,
  result: RepairResult,
  workspaceRoot: string
): Promise<TargetedCheck> {
  const params = action.parameters as Record<string, unknown>;
  const root = workspaceRootFor(action, workspaceRoot);

  switch (action.type) {
    case 'create-environment':
    case 'update-manifest': {
      if (typeof params['content'] === 'string' && typeof params['path'] === 'string') {
        const fullPath = resolve(root, params['path']);
        if (!(await fileExists(fullPath))) {
          return { passed: false, description: `Created file missing at ${String(params['path'])}` };
        }
        const content = await fs.readFile(fullPath, 'utf-8').catch(() => undefined);
        if (content !== params['content']) {
          return { passed: false, description: `Created file content mismatch at ${String(params['path'])}` };
        }
        return { passed: true, description: `Created file verified at ${String(params['path'])}` };
      }
      if (typeof params['path'] === 'string') {
        const fullPath = resolve(root, params['path']);
        const dirExists = await fileExists(fullPath);
        if (!dirExists) {
          return { passed: false, description: `Environment path missing at ${String(params['path'])}` };
        }
        const marker = await fileExists(resolve(fullPath, 'pyvenv.cfg'));
        return {
          passed: true,
          description: marker
            ? `Python virtual environment verified at ${String(params['path'])}`
            : `Environment directory exists at ${String(params['path'])} (interpreter marker not confirmed)`,
        };
      }
      return { passed: result.success, description: 'No targeted file check available; relied on action outcome' };
    }
    case 'modify-configuration': {
      if (typeof params['path'] === 'string' && typeof params['replace'] === 'string') {
        const fullPath = resolve(root, params['path']);
        const content = await fs.readFile(fullPath, 'utf-8').catch(() => undefined);
        if (content === undefined) {
          return { passed: false, description: `Modified file missing at ${String(params['path'])}` };
        }
        if (!content.includes(params['replace'])) {
          return { passed: false, description: `Expected replacement text absent in ${String(params['path'])}` };
        }
        return { passed: true, description: `Modified file verified at ${String(params['path'])}` };
      }
      return { passed: result.success, description: 'No targeted file check available; relied on action outcome' };
    }
    case 'install-dependency': {
      return {
        passed: result.success,
        description: result.success
          ? `Installer reported success for ${String(params['package'] ?? 'package')} (no local inventory to confirm; blocking diagnostics re-checked)`
          : `Installer reported failure for ${String(params['package'] ?? 'package')}`,
      };
    }
    default: {
      return { passed: result.success, description: 'No targeted check for action type; relied on action outcome' };
    }
  }
}

export class VerificationEngineImpl implements VerificationEngine {
  private rules: VerificationRule[] = [];

  registerVerificationRule(rule: VerificationRule): void {
    this.rules.push(rule);
  }

  async verify(action: RepairAction, context: VerificationContext): Promise<VerificationResult> {
    const root = context.workspace.rootPath;
    const check = await targetedCheck(
      action,
      { success: true },
      root
    );

    let ruleSuccess = true;
    const ruleNotes: string[] = [];
    for (const rule of this.rules) {
      if (!rule.applicableActionTypes.includes(action.type)) {
        continue;
      }
      try {
        const ruleResult = await rule.verify(context);
        ruleNotes.push(`${rule.id}: ${ruleResult.success ? 'pass' : 'fail'}`);
        if (!ruleResult.success) {
          ruleSuccess = false;
        }
      } catch (err) {
        ruleNotes.push(`${rule.id}: error ${err instanceof Error ? err.message : String(err)}`);
        ruleSuccess = false;
      }
    }

    return {
      repairPlanId: '',
      actionId: action.id,
      success: check.passed && ruleSuccess,
      diagnostics: context.originalDiagnostics,
      timestamp: new Date(),
      metadata: {
        targetedCheck: check.description,
        ruleNotes,
      },
    };
  }

  async verifyPlan(
    executed: ReadonlyArray<{ action: RepairAction; result: RepairResult }>,
    before: AgentAnalysis,
    after: AgentAnalysis,
    workspaceRoot: string
  ): Promise<VerificationReport> {
    const beforeKeys = new Set(before.blockingDiagnostics.map(diagnosticKey));
    const afterBlocking = after.diagnostics.filter(isBlockingDiagnostic);
    const afterKeys = new Set(afterBlocking.map(diagnosticKey));

    const resolvedDiagnostics = [...beforeKeys].filter((key) => !afterKeys.has(key));
    const persisting = [...beforeKeys].filter((key) => afterKeys.has(key));
    const regressions = [...afterKeys].filter((key) => !beforeKeys.has(key));
    const remainingDiagnostics = [...persisting, ...regressions];

    const evidence: VerificationEvidence[] = [
      {
        source: 'diagnostic-rerun',
        description: `Re-ran diagnostics: ${resolvedDiagnostics.length} resolved, ${remainingDiagnostics.length} remaining blocking`,
      },
    ];

    let targetedFailures = 0;
    for (const { action, result } of executed) {
      if (!result.success) {
        evidence.push({
          source: 'targeted-check',
          actionId: action.id,
          passed: false,
          description: `Action did not succeed; targeted check skipped for ${action.id}`,
        });
        targetedFailures += 1;
        continue;
      }
      const check = await targetedCheck(action, result, workspaceRoot);
      evidence.push({
        source: 'targeted-check',
        actionId: action.id,
        passed: check.passed,
        description: check.description,
      });
      if (!check.passed) {
        targetedFailures += 1;
      }
    }

    const success = remainingDiagnostics.length === 0 && targetedFailures === 0;
    const summary = success
      ? `Verified: all ${beforeKeys.size} blocking diagnostics resolved`
      : `Not resolved: ${persisting.length} persisting, ${regressions.length} new blocking diagnostics, ${targetedFailures} failed targeted checks`;

    return {
      success,
      diagnostics: after.diagnostics,
      resolvedDiagnostics,
      remainingDiagnostics,
      evidence,
      summary,
    };
  }
}

export function createVerificationEngine(): VerificationEngineImpl {
  return new VerificationEngineImpl();
}
