import type { VersionMatchResult } from '../core/interfaces.js';

const OPERATOR_PATTERNS: ReadonlyArray<{ operator: string; pattern: RegExp }> = [
  { operator: '==', pattern: /^==\s*(.+)$/ },
  { operator: '!=', pattern: /^!=\s*(.+)$/ },
  { operator: '>=', pattern: /^>=\s*(.+)$/ },
  { operator: '<=', pattern: /^<=\s*(.+)$/ },
  { operator: '>', pattern: /^>\s*(.+)$/ },
  { operator: '<', pattern: /^<\s*(.+)$/ },
  { operator: '~=', pattern: /^~=\s*(.+)$/ },
  { operator: '~', pattern: /^~\s*(.+)$/ },
  { operator: '^', pattern: /^\^\s*(.+)$/ },
];

export function parseConstraint(constraint: string): { operator: string; version: string } | null {
  const trimmed = constraint.trim();
  
  if (!trimmed || trimmed === '*' || trimmed === 'latest') {
    return { operator: 'none', version: '*' };
  }

  for (const { operator, pattern } of OPERATOR_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match && match[1]) {
      return { operator, version: match[1].trim() };
    }
  }

  // No operator found - assume exact version
  return { operator: '==', version: trimmed };
}

function parseVersion(version: string): number[] {
  return version
    .split(/[.-]/)
    .map(part => {
      const num = parseInt(part, 10);
      return isNaN(num) ? 0 : num;
    });
}

function compareVersions(a: string, b: string): number {
  const partsA = parseVersion(a);
  const partsB = parseVersion(b);
  
  const maxLen = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLen; i++) {
    const aPart = partsA[i] || 0;
    const bPart = partsB[i] || 0;
    if (aPart < bPart) return -1;
    if (aPart > bPart) return 1;
  }
  return 0;
}

export function matches(constraint: string, version: string): VersionMatchResult {
  if (!version || version === 'unknown' || version === 'missing') {
    return { satisfied: false, reason: 'unknown', details: 'Version not available' };
  }

  if (!constraint || constraint === '*' || constraint === 'latest') {
    return { satisfied: true };
  }

  const parsed = parseConstraint(constraint);
  if (!parsed) {
    return { satisfied: false, reason: 'unknown', details: `Could not parse constraint: ${constraint}` };
  }

  const { operator, version: constraintVersion } = parsed;

  if (operator === 'none') {
    return { satisfied: true };
  }

  if (operator === '==') {
    const cmp = compareVersions(version, constraintVersion);
    if (cmp === 0) return { satisfied: true };
    return { satisfied: false, reason: `Expected version ${constraintVersion}, got ${version}` };
  }

  if (operator === '!=') {
    const cmp = compareVersions(version, constraintVersion);
    if (cmp !== 0) return { satisfied: true };
    return { satisfied: false, reason: `Version should not be ${constraintVersion}, but is ${version}` };
  }

  if (operator === '>=') {
    const cmp = compareVersions(version, constraintVersion);
    if (cmp >= 0) return { satisfied: true };
    return { satisfied: false, reason: `Expected version >= ${constraintVersion}, got ${version}` };
  }

  if (operator === '<=') {
    const cmp = compareVersions(version, constraintVersion);
    if (cmp <= 0) return { satisfied: true };
    return { satisfied: false, reason: `Expected version <= ${constraintVersion}, got ${version}` };
  }

  if (operator === '>') {
    const cmp = compareVersions(version, constraintVersion);
    if (cmp > 0) return { satisfied: true };
    return { satisfied: false, reason: `Expected version > ${constraintVersion}, got ${version}` };
  }

  if (operator === '<') {
    const cmp = compareVersions(version, constraintVersion);
    if (cmp < 0) return { satisfied: true };
    return { satisfied: false, reason: `Expected version < ${constraintVersion}, got ${version}` };
  }

  if (operator === '~' || operator === '~=') {
    // Tilde: ~1.2.3 means >=1.2.3 <1.3.0
    // ~=1.2.3 means >=1.2.3 <1.3.0 (PEP 440 compatible release)
    const parts = constraintVersion.split('.').map(Number);
    if (parts.length >= 2 && parts[0] !== undefined && parts[1] !== undefined) {
      const minVersion = constraintVersion;
      const maxVersion = `${parts[0]}.${parts[1] + 1}.0`;
      const cmpMin = compareVersions(version, minVersion);
      const cmpMax = compareVersions(version, maxVersion);
      if (cmpMin >= 0 && cmpMax < 0) return { satisfied: true };
      return { satisfied: false, reason: `Expected version ~${constraintVersion} (>=${minVersion} <${maxVersion}), got ${version}` };
    }
  }

  if (operator === '^') {
    // Caret: ^1.2.3 means >=1.2.3 <2.0.0
    const parts = constraintVersion.split('.').map(Number);
    if (parts.length >= 1 && parts[0] !== undefined) {
      const minVersion = constraintVersion;
      const maxVersion = `${parts[0] + 1}.0.0`;
      const cmpMin = compareVersions(version, minVersion);
      const cmpMax = compareVersions(version, maxVersion);
      if (cmpMin >= 0 && cmpMax < 0) return { satisfied: true };
      return { satisfied: false, reason: `Expected version ^${constraintVersion} (>=${minVersion} <${maxVersion}), got ${version}` };
    }
  }

  return { satisfied: false, reason: 'unknown', details: `Unsupported operator: ${operator}` };
}

export function compare(a: string, b: string): number {
  return compareVersions(a, b);
}

export const versionMatcher = {
  matches,
  compare,
  parseConstraint,
};