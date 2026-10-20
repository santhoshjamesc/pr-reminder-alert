/**
 * Redaction helpers shared by the service logger, API error responses and the
 * extension output channel. Anything that might contain a credential or an
 * email address should pass through `redactString` / `redactValue` before it
 * is logged or returned to a client.
 */

const SECRET_KEY_PATTERN = /(token|password|passwd|secret|authorization|auth|apikey|api_key|cookie|credential|pass)$/i;

const SECRET_VALUE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // GitHub tokens: classic (ghp_), OAuth (gho_), user-to-server (ghu_), server-to-server (ghs_), refresh (ghr_), fine-grained PATs.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  // Google OAuth access tokens, refresh tokens and OAuth client secrets.
  [/\bya29\.[A-Za-z0-9._-]{10,}/g, '[REDACTED_GOOGLE_TOKEN]'],
  [/\b1\/\/[A-Za-z0-9._-]{20,}/g, '[REDACTED_GOOGLE_TOKEN]'],
  [/\bGOCSPX-[A-Za-z0-9_-]{10,}/g, '[REDACTED_GOOGLE_SECRET]'],
  // HTTP authorization headers.
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  // key=value / key: value pairs for well-known secret names.
  [
    /\b(GITHUB_TOKEN|GOOGLE_CLIENT_SECRET|GOOGLE_REFRESH_TOKEN|PR_REMINDER_API_TOKEN|refresh_token|access_token|client_secret|password|pass|token|secret)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    '$1$2[REDACTED]',
  ],
];

const EMAIL_PATTERN = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

/** Additional exact secret values (e.g. the configured token) to scrub wherever they appear. */
const knownSecrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) {
    knownSecrets.add(value);
  }
}

export function clearRegisteredSecrets(): void {
  knownSecrets.clear();
}

/** Masks a phone number (digits, country code first) to e.g. +91******3210. */
export function maskPhone(digits: string): string {
  return digits.length <= 4 ? '+****' : `+${digits.slice(0, 2)}${'*'.repeat(Math.max(0, digits.length - 6))}${digits.slice(-4)}`;
}

export function maskEmail(email: string): string {
  return email.replace(EMAIL_PATTERN, (_m, first: string, domain: string) => `${first}***@${domain}`);
}

export interface RedactOptions {
  /** Mask email addresses (personal information). Defaults to true. */
  maskEmails?: boolean;
}

export function redactString(input: string, options: RedactOptions = {}): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  if (options.maskEmails !== false) {
    out = maskEmail(out);
  }
  return out;
}

export function redactValue(value: unknown, options: RedactOptions = {}, depth = 0): unknown {
  if (depth > 8) {
    return '[Truncated]';
  }
  if (typeof value === 'string') {
    return redactString(value, options);
  }
  if (value instanceof Error) {
    const extra = value as Error & { code?: unknown; status?: unknown };
    return {
      name: value.name,
      message: redactString(value.message, options),
      ...(typeof extra.code === 'string' ? { code: extra.code } : {}),
      ...(typeof extra.status === 'number' ? { status: extra.status } : {}),
    };
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, options, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) && v !== undefined && v !== null && v !== '' ? '[REDACTED]' : redactValue(v, options, depth + 1);
    }
    return out;
  }
  return value;
}

/** Returns a safe, redacted message for an unknown error. */
export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactString(message);
}
