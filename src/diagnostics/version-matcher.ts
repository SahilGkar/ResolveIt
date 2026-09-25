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
      return { operator, version: stripLeadingV(match[1].trim()) };
    }
  }

  // No operator found - assume exact version (prefix semantics for partial versions)
  return { operator: '==', version: stripLeadingV(trimmed) };
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

export function stripLeadingV(version: string): string {
  const trimmed = version.trim();
  if (/^[vV]\d/.test(trimmed)) {
    return trimmed.slice(1);
  }
  return trimmed;
}

function splitVersionParts(version: string): string[] {
  return stripLeadingV(version).split('+')[0]?.split(/[.-]/) ?? [];
}

function matchesWildcardPrefix(constraintVersion: string, version: string): boolean {
  const normalized = constraintVersion.trim().replace(/\.x$/i, '.*');
  const starIndex = normalized.indexOf('*');
  if (starIndex === -1) {
    return false;
  }
  const prefix = normalized.slice(0, starIndex).replace(/[.-]+$/, '');
  if (!prefix) {
    return true;
  }
  const prefixParts = prefix.split(/[.-]/);
  const versionParts = splitVersionParts(version);
  for (let i = 0; i < prefixParts.length; i++) {
    const expected = Number(prefixParts[i]);
    const actual = Number(versionParts[i]);
    if (!Number.isFinite(expected) || !Number.isFinite(actual) || expected !== actual) {
      return false;
    }
  }
  return true;
}

function matchesMavenRange(constraint: string, version: string): VersionMatchResult | undefined {
  const trimmed = constraint.trim();
  const rangeMatch = trimmed.match(/^([([])\s*([^,)\]]*?)\s*(?:,\s*([^,)\]]*?)\s*)?([)\]])$/);
  if (!rangeMatch) {
    return undefined;
  }
  const lowerInclusive = rangeMatch[1] === '[';
  const upperInclusive = rangeMatch[4] === ']';
  const lower = (rangeMatch[2] ?? '').trim();
  const hasComma = rangeMatch[3] !== undefined;
  const upper = (rangeMatch[3] ?? '').trim();

  if (!hasComma) {
    if (!lower) {
      return undefined;
    }
    const cmp = compareVersions(version, lower);
    if (cmp === 0) {
      return { satisfied: true };
    }
    return { satisfied: false, reason: `Expected version ${trimmed}, got ${version}` };
  }

  if (lower) {
    const cmp = compareVersions(version, lower);
    if ((lowerInclusive && cmp < 0) || (!lowerInclusive && cmp <= 0)) {
      return { satisfied: false, reason: `Expected version ${trimmed}, got ${version}` };
    }
  }
  if (upper) {
    const cmp = compareVersions(version, upper);
    if ((upperInclusive && cmp > 0) || (!upperInclusive && cmp >= 0)) {
      return { satisfied: false, reason: `Expected version ${trimmed}, got ${version}` };
    }
  }
  return { satisfied: true };
}

function matchesHyphenRange(constraint: string, version: string): VersionMatchResult | undefined {
  const hyphenMatch = constraint.match(/^(.+?)\s+-\s+(.+)$/);
  if (!hyphenMatch || !hyphenMatch[1] || !hyphenMatch[2]) {
    return undefined;
  }
  const lower = hyphenMatch[1].trim();
  const upper = hyphenMatch[2].trim();
  if (compareVersions(version, lower) < 0 || compareVersions(version, upper) > 0) {
    return { satisfied: false, reason: `Expected version ${constraint.trim()}, got ${version}` };
  }
  return { satisfied: true };
}

export function matches(constraint: string, version: string): VersionMatchResult {
  const cleanVersion = stripLeadingV(version);
  if (!cleanVersion || cleanVersion === 'unknown' || cleanVersion === 'missing') {
    return { satisfied: false, reason: 'unknown', details: 'Version not available' };
  }

  if (!constraint || constraint === '*' || constraint === 'latest') {
    return { satisfied: true };
  }

  const cleanConstraint = constraint.trim();
  if (/^(latest\.(integration|release)|LATEST|RELEASE)$/i.test(cleanConstraint)) {
    return { satisfied: true };
  }

  if (cleanConstraint.includes('||')) {
    const branches = cleanConstraint.split('||').map((branch) => branch.trim()).filter((branch) => branch !== '');
    if (branches.length === 0) {
      return { satisfied: false, reason: 'unknown', details: `Could not parse constraint: ${constraint}` };
    }
    const failures: string[] = [];
    for (const branch of branches) {
      const result = matches(branch, cleanVersion);
      if (result.satisfied) {
        return { satisfied: true };
      }
      failures.push(result.reason);
    }
    return { satisfied: false, reason: `No alternative satisfied (${failures.join('; ')})` };
  }

  const mavenRange = matchesMavenRange(cleanConstraint, cleanVersion);
  if (mavenRange) {
    return mavenRange;
  }

  const hyphenRange = matchesHyphenRange(cleanConstraint, cleanVersion);
  if (hyphenRange) {
    return hyphenRange;
  }

  let normalized = cleanConstraint;
  if (normalized.startsWith('===')) {
    normalized = `==${normalized.slice(3).trim()}`;
  }
  if (/^[vV]\d/.test(normalized)) {
    normalized = normalized.slice(1);
  }
  const plusMatch = normalized.match(/^(\d[\d.]*)\.\+$/);
  if (plusMatch && plusMatch[1]) {
    normalized = `${plusMatch[1]}.*`;
  }

  const parsed = parseConstraint(normalized);
  if (!parsed) {
    return { satisfied: false, reason: 'unknown', details: `Could not parse constraint: ${constraint}` };
  }

  const { operator, version: constraintVersion } = parsed;

  if (operator === 'none') {
    return { satisfied: true };
  }

  if (/[*]/.test(constraintVersion) || /\.x$/i.test(constraintVersion)) {
    if (matchesWildcardPrefix(constraintVersion, cleanVersion)) {
      return { satisfied: true };
    }
    return { satisfied: false, reason: `Expected version ${constraintVersion}, got ${cleanVersion}` };
  }

  version = cleanVersion;

  if (operator === '==') {
    // Bare and == constraints use prefix semantics: '1.22' matches '1.22.x'
    // (language directives commonly pin partial versions). Missing segments count as 0.
    const expected = constraintVersion.split(/[.-]/);
    const actual = splitVersionParts(version);
    let equal = true;
    for (let i = 0; i < expected.length; i++) {
      const want = Number(expected[i]);
      const got = Number(actual[i] ?? '0');
      if (!Number.isFinite(want) || !Number.isFinite(got) || want !== got) {
        equal = false;
        break;
      }
    }
    if (equal) return { satisfied: true };
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
    // Tilde: ~1.2.3 means >=1.2.3 <1.3.0; ~1 means >=1 <2.
    // PEP 440 ~=: ~=1.4 means >=1.4 <2; ~=1.4.2 means >=1.4.2 <1.5.
    const parts = constraintVersion.split('.').map(Number);
    if (parts.some((part) => !Number.isFinite(part))) {
      return { satisfied: false, reason: 'unknown', details: `Could not parse constraint: ${constraint}` };
    }
    let maxVersion: string;
    if (operator === '~=') {
      const prefix = parts.slice(0, -1);
      if (prefix.length === 0) {
        maxVersion = `${parts[0] as number + 1}`;
      } else {
        const bumped = [...prefix.slice(0, -1), (prefix[prefix.length - 1] as number) + 1];
        maxVersion = bumped.join('.');
      }
    } else {
      const first = parts[0] as number;
      const second = parts.length > 1 ? (parts[1] as number) : 0;
      maxVersion = parts.length > 1 ? `${first}.${second + 1}.0` : `${first + 1}`;
    }
    const cmpMin = compareVersions(version, constraintVersion);
    const cmpMax = compareVersions(version, maxVersion);
    if (cmpMin >= 0 && cmpMax < 0) return { satisfied: true };
    return { satisfied: false, reason: `Expected version ${operator}${constraintVersion} (>=${constraintVersion} <${maxVersion}), got ${version}` };
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