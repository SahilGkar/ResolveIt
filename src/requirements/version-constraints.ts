import { VersionConstraint, VersionOperator } from '../core/models.js';

export { VersionConstraint, VersionOperator };

const OPERATOR_PATTERNS: ReadonlyArray<{ operator: VersionOperator; pattern: RegExp }> = [
  { operator: '==', pattern: /^==\s*(.+)$/ },
  { operator: '!=', pattern: /^!=\s*(.+)$/ },
  { operator: '>=', pattern: /^>=\s*(.+)$/ },
  { operator: '<=', pattern: /^<=\s*(.+)$/ },
  { operator: '>', pattern: /^>\s*(.+)$/ },
  { operator: '<', pattern: /^<\s*(.+)$/ },
  { operator: '~=', pattern: /^~=\s*(.+)$/ },
  { operator: '~', pattern: /^~\s*(.+)$/ },
  { operator: '^', pattern: /^\^\s*(.+)$/ },
  { operator: '*', pattern: /^\*\s*(.+)$/ },
];

export function parseVersionConstraint(constraint: string): VersionConstraint | null {
  const trimmed = constraint.trim();
  
  if (!trimmed || trimmed === '*') {
    return { operator: 'none', version: '*', raw: trimmed };
  }

  for (const { operator, pattern } of OPERATOR_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match && match[1]) {
      return {
        operator,
        version: match[1].trim(),
        raw: trimmed,
      };
    }
  }

  // No operator found, assume exact version or version range
  return {
    operator: '==',
    version: trimmed,
    raw: trimmed,
  };
}

export function normalizeConstraint(constraint: string): string {
  const parsed = parseVersionConstraint(constraint);
  if (!parsed) return constraint;
  if (parsed.operator === 'none') return '*';
  return `${parsed.operator}${parsed.version}`;
}

export function compareConstraints(a: string, b: string): boolean {
  return normalizeConstraint(a) === normalizeConstraint(b);
}

export function isValidVersion(version: string): boolean {
  // Basic semver validation
  const semverPattern = /^\d+(\.\d+){0,2}(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;
  return semverPattern.test(version) || version === '*';
}

export function extractVersionFromRange(range: string): string | null {
  const parsed = parseVersionConstraint(range);
  if (!parsed) return null;
  return parsed.version;
}

export function isCompatible(_constraint: string, _version: string): boolean {
  // This is a placeholder for actual version comparison logic
  // Full implementation would use a semver library
  return true;
}