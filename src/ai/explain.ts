import type {
  AIExplanationContext,
  AIExplanationResult,
  AIExplainedAction,
  Diagnostic,
  RepairAction,
  RepairPlan,
} from '../core/models.js';
import type { AIProvider } from '../core/interfaces.js';
import { AIProviderError } from './errors.js';
import { SECURITY_LIMITS, byteLength, truncateText } from '../safety/limits.js';
import { redactSecrets } from '../safety/secrets.js';

export interface ExplanationInput {
  readonly projectName: string;
  readonly workspaceRoot: string;
  readonly plan: RepairPlan;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

export type ExplanationStatus =
  | { status: 'ready'; explanation: AIExplanationResult }
  | { status: 'unavailable'; reason: string };

const MAX_EXPLAIN_ACTIONS = 32;
const MAX_TEXT_CHARS = 2000;
const MAX_TITLE_CHARS = 200;

/**
 * Package managers behind the controlled installer. Install actions carry the
 * installer ecosystem in their parameters (`npm`, `pip`, ...); requirement
 * ecosystems (`node`, `python`, ...) map onto the same managers. Used only
 * as a deterministic fact in explanation context, never as an instruction.
 */
const INSTALLER_ECOSYSTEMS: ReadonlySet<string> = new Set([
  'npm',
  'pip',
  'cargo',
  'go',
  'composer',
  'bundler',
]);

const REQUIREMENT_ECOSYSTEM_MANAGERS: Readonly<Record<string, string>> = {
  node: 'npm',
  python: 'pip',
  rust: 'cargo',
  go: 'go',
  php: 'composer',
  ruby: 'bundler',
};

function packageManagerFor(actionType: string, ecosystem: string | undefined): string | undefined {
  if (ecosystem === undefined) {
    return undefined;
  }
  if (actionType === 'install-dependency' && INSTALLER_ECOSYSTEMS.has(ecosystem)) {
    return ecosystem;
  }
  return REQUIREMENT_ECOSYSTEM_MANAGERS[ecosystem];
}

function clean(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  return redactSecrets(truncateText(trimmed, maxChars));
}

function diagnosticForAction(
  action: RepairAction,
  diagnostics: ReadonlyArray<Diagnostic>
): Diagnostic | undefined {
  const params = (action.parameters ?? {}) as Record<string, unknown>;
  const pkg = params['package'];
  if (typeof pkg === 'string' && pkg !== '') {
    const match = diagnostics.find((diag) => diag.requirement?.name === pkg);
    if (match) {
      return match;
    }
  }
  const targetFile = action.target?.filePath;
  if (typeof targetFile === 'string' && targetFile !== '') {
    const match = diagnostics.find((diag) => diag.affectedFiles?.includes(targetFile) === true);
    if (match) {
      return match;
    }
  }
  return undefined;
}

/**
 * Build the minimal, sanitized context the AI needs to *explain* an existing
 * deterministic plan. Only safe scalar fields cross the boundary: ids, types,
 * descriptions, package coordinates, and diagnostic summaries. Secrets are
 * redacted, file contents are never included, and the full parameters object
 * is never passed.
 */
export function buildExplanationContext(input: ExplanationInput): AIExplanationContext {
  const totalActions = input.plan.actions.length;
  const truncated = totalActions > MAX_EXPLAIN_ACTIONS;
  const actions = input.plan.actions.slice(0, MAX_EXPLAIN_ACTIONS).map((action) => {
    const params = (action.parameters ?? {}) as Record<string, unknown>;
    const diagnostic = diagnosticForAction(action, input.diagnostics);
    const scalar = (key: string): string | undefined => {
      const value = params[key];
      return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number'
        ? redactSecrets(truncateText(String(value), 256))
        : undefined;
    };
    const ecosystem = scalar('ecosystem');
    return {
      actionId: action.id,
      actionType: action.type,
      description: redactSecrets(truncateText(action.description, 500)),
      ...(typeof action.target?.filePath === 'string' && action.target.filePath !== ''
        ? { targetFile: redactSecrets(truncateText(action.target.filePath, 256)) }
        : {}),
      ...(scalar('package') !== undefined ? { package: scalar('package') as string } : {}),
      ...(ecosystem !== undefined ? { ecosystem } : {}),
      ...(packageManagerFor(action.type, ecosystem) !== undefined
        ? { packageManager: packageManagerFor(action.type, ecosystem) as string }
        : {}),
      ...(scalar('version') !== undefined ? { version: scalar('version') as string } : {}),
      ...(diagnostic === undefined
        ? {}
        : {
            diagnosticCode: diagnostic.code,
            diagnosticCategory: diagnostic.category,
            diagnosticSeverity: diagnostic.severity,
            ...(clean(diagnostic.message, 1000) === undefined
              ? {}
              : { diagnosticMessage: clean(diagnostic.message, 1000) as string }),
          }),
    };
  });
  return {
    projectName: redactSecrets(truncateText(input.projectName, 256)),
    workspaceRoot: redactSecrets(truncateText(input.workspaceRoot, 256)),
    planDescription: redactSecrets(truncateText(input.plan.description, 500)),
    totalActions,
    truncated,
    actions,
  };
}

export interface ExplanationPrompt {
  readonly system: string;
  readonly user: string;
}

export function buildExplanationPrompt(context: AIExplanationContext): ExplanationPrompt {
  const system = [
    'You explain an existing, deterministic repair plan to a beginner programmer.',
    'Rules:',
    '1. Output JSON only, matching this schema: {"summary": string, "actions": [{"actionId": string, "title": string, "whatItMeans": string, "whyDetected": string, "whatResolveItWillDo": string, "expectedResult": string, "notes"?: string}], "generalNotes"?: string}.',
    `2. The plan has exactly ${context.totalActions} action(s), listed below. Include exactly one entry per listed action, using its exact actionId. Never add, remove, or rename actions, and never change the count.`,
    '3. Do not propose new repairs, commands, or shell instructions. Describe only what ResolveIt will do with its own safe repair mechanism.',
    '4. Use plain, beginner-friendly language. Keep each field under a short paragraph.',
    '5. If something is unclear from the context, say so in notes instead of inventing facts.',
  ].join('\n');
  const user = [
    `Project: ${context.projectName}`,
    `Plan: ${context.planDescription} (${context.totalActions} action(s))`,
    ...context.actions.map((action) => {
      const parts = [
        `- actionId: ${action.actionId}`,
        `  type: ${action.actionType}`,
        `  description: ${action.description}`,
      ];
      if (action.targetFile !== undefined) {
        parts.push(`  file: ${action.targetFile}`);
      }
      if (action.package !== undefined) {
        parts.push(
          `  package: ${action.package}${action.packageManager !== undefined ? ` (install with ${action.packageManager})` : ''}${action.version !== undefined ? ` version ${action.version}` : ''}`
        );
      }
      if (action.diagnosticMessage !== undefined) {
        parts.push(
          `  detected because: [${action.diagnosticSeverity ?? 'unknown'}] ${action.diagnosticMessage}`
        );
      }
      return parts.join('\n');
    }),
  ].join('\n');
  return { system, user };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1] !== undefined) {
    return fence[1].trim();
  }
  return trimmed;
}

/**
 * Strictly validate an AI explanation response. Every entry must reference an
 * actionId from the plan the AI was asked to explain; anything else (unknown
 * ids, wrong types, oversized text) rejects the whole response rather than
 * rendering untrusted data. The returned object contains only schema fields.
 */
export function parseAIExplanationResponse(text: string, validActionIds: ReadonlySet<string>): AIExplanationResult {
  if (!text || text.trim() === '') {
    throw new AIProviderError('empty', 'AI provider returned an empty explanation');
  }
  if (byteLength(text) > SECURITY_LIMITS.maxAiResponseBytes) {
    throw new AIProviderError(
      'oversized',
      `AI explanation exceeds maximum size (${SECURITY_LIMITS.maxAiResponseBytes} bytes)`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMarkdownFences(text)) as unknown;
  } catch {
    throw new AIProviderError('malformed', 'AI explanation is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new AIProviderError('malformed', 'AI explanation must be a JSON object');
  }
  return validateExplanationPayload(parsed, validActionIds);
}

/**
 * Entry keys the schema allows. Anything else (commands, shell fields,
 * parameters, action-creating or approval-adjacent keys) rejects the whole
 * response: the explanation layer must never carry executable content.
 */
const ALLOWED_ENTRY_KEYS: ReadonlySet<string> = new Set([
  'actionId',
  'title',
  'whatItMeans',
  'whyDetected',
  'whatResolveItWillDo',
  'expectedResult',
  'notes',
]);

function validateExplanationPayload(
  parsed: Record<string, unknown>,
  validActionIds: ReadonlySet<string>
): AIExplanationResult {
  const summary = clean(parsed['summary'], MAX_TEXT_CHARS);
  if (summary === undefined) {
    throw new AIProviderError('malformed', 'AI explanation is missing a summary');
  }
  if (!Array.isArray(parsed['actions'])) {
    throw new AIProviderError('malformed', 'AI explanation is missing an actions array');
  }
  if (parsed['actions'].length > MAX_EXPLAIN_ACTIONS * 2) {
    throw new AIProviderError('oversized', 'AI explanation contains too many entries');
  }
  const seen = new Set<string>();
  const actions: AIExplainedAction[] = [];
  for (const entry of parsed['actions']) {
    if (!isRecord(entry)) {
      throw new AIProviderError('malformed', 'AI explanation entry must be an object');
    }
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_ENTRY_KEYS.has(key)) {
        throw new AIProviderError(
          'malformed',
          `AI explanation entry contains an unsupported field (${key}); the plan is unchanged`
        );
      }
    }
    const actionId = entry['actionId'];
    if (typeof actionId !== 'string' || !validActionIds.has(actionId)) {
      throw new AIProviderError(
        'malformed',
        'AI explanation references an unknown repair action; the plan is unchanged'
      );
    }
    if (seen.has(actionId)) {
      throw new AIProviderError('malformed', 'AI explanation repeats a repair action');
    }
    seen.add(actionId);
    const title = clean(entry['title'], MAX_TITLE_CHARS);
    const whatItMeans = clean(entry['whatItMeans'], MAX_TEXT_CHARS);
    const whyDetected = clean(entry['whyDetected'], MAX_TEXT_CHARS);
    const whatResolveItWillDo = clean(entry['whatResolveItWillDo'], MAX_TEXT_CHARS);
    const expectedResult = clean(entry['expectedResult'], MAX_TEXT_CHARS);
    if (
      title === undefined ||
      whatItMeans === undefined ||
      whyDetected === undefined ||
      whatResolveItWillDo === undefined ||
      expectedResult === undefined
    ) {
      throw new AIProviderError('malformed', 'AI explanation entry is missing required fields');
    }
    const notes = clean(entry['notes'], MAX_TEXT_CHARS);
    actions.push({
      actionId,
      title,
      whatItMeans,
      whyDetected,
      whatResolveItWillDo,
      expectedResult,
      ...(notes === undefined ? {} : { notes }),
    });
  }
  // Exact coverage: with duplicates already rejected, equal length means the
  // explanation describes exactly the plan's actions -- no omissions, no
  // inventions, no count changes.
  if (actions.length !== validActionIds.size) {
    throw new AIProviderError(
      'malformed',
      'AI explanation does not cover exactly the repair plan actions; the plan is unchanged'
    );
  }
  const generalNotes = clean(parsed['generalNotes'], MAX_TEXT_CHARS);
  return {
    summary,
    actions,
    ...(generalNotes === undefined ? {} : { generalNotes }),
  };
}

/**
 * Request a read-only explanation of an already-built deterministic plan.
 * Never throws for provider problems: unavailability, misconfiguration,
 * timeouts, and malformed output all resolve to an `unavailable` status so
 * the repair plan stays usable. The explanation can never feed back into
 * planning or execution -- it is rendered as information only.
 */
export async function requestRepairExplanation(
  provider: AIProvider,
  context: AIExplanationContext
): Promise<ExplanationStatus> {
  if (provider.type === 'none' || typeof provider.explainPlan !== 'function') {
    return { status: 'unavailable', reason: 'AI explanation is not configured for this provider.' };
  }
  if (context.truncated || context.actions.length !== context.totalActions) {
    return {
      status: 'unavailable',
      reason: 'The repair plan has more actions than can be explained reliably.',
    };
  }
  let result: AIExplanationResult;
  try {
    result = await provider.explainPlan(context);
  } catch (err) {
    const reason = err instanceof AIProviderError ? `${err.code}: ${err.message}` : 'AI explanation request failed.';
    return { status: 'unavailable', reason };
  }
  if (!isRecord(result)) {
    return { status: 'unavailable', reason: 'malformed: AI explanation must be a JSON object' };
  }
  try {
    const validIds = new Set(context.actions.map((action) => action.actionId));
    const explanation = validateExplanationPayload(result, validIds);
    return { status: 'ready', explanation };
  } catch (err) {
    const reason = err instanceof AIProviderError ? `${err.code}: ${err.message}` : 'AI explanation was invalid.';
    return { status: 'unavailable', reason };
  }
}
