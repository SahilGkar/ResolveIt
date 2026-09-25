const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'auth',
  'privatekey',
  'credential',
  'sessionkey',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
];

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

export function sanitizeParameters(
  parameters: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (isSensitiveKey(key)) {
      sanitized[key] = '[REDACTED]';
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      sanitized[key] = sanitizeParameters(value as Readonly<Record<string, unknown>>);
    } else if (typeof value === 'string') {
      sanitized[key] = redactSecrets(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/g, replacement: 'Bearer [REDACTED]' },
  { pattern: /Basic\s+[A-Za-z0-9+/=]{8,}/g, replacement: 'Basic [REDACTED]' },
  {
    pattern: /(['"]?(?:api[_-]?key|apikey|auth[_-]?token|access[_-]?token|secret|client[_-]?secret)['"]?\s*[:=]\s*['"]?)([^'"\s,};&|]+)/gi,
    replacement: '$1[REDACTED]',
  },
  {
    pattern: /\b(sk-(?:live|test)-[A-Za-z0-9]{8,}|sk-ant-[A-Za-z0-9\-_]{8,}|xox[bpas]-[A-Za-z0-9\-_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16})\b/g,
    replacement: '[REDACTED]',
  },
  {
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

const ENV_SECRET_HINTS = [
  'key',
  'token',
  'secret',
  'password',
  'passwd',
  'auth',
  'credential',
];

export function isSecretEnvVar(name: string): boolean {
  const lower = name.toLowerCase();
  return ENV_SECRET_HINTS.some((hint) => lower.includes(hint));
}

export function sanitizeEnvironment(
  env: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = isSecretEnvVar(key) ? '[REDACTED]' : value;
  }
  return result;
}

const ENV_FILE_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
]);

const ENV_TEMPLATE_BASENAMES = new Set(['.env.example', '.env.sample', '.env.template']);

export function isEnvFile(fileName: string): boolean {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName;
  if (ENV_TEMPLATE_BASENAMES.has(base)) {
    return false;
  }
  if (ENV_FILE_BASENAMES.has(base)) {
    return true;
  }
  return base === '.env' || base.startsWith('.env.');
}
