import { afterEach, describe, expect, it } from 'vitest';
import { clearRegisteredSecrets, maskEmail, redactString, redactValue, registerSecret } from '../src/shared/redact';
import { createLogger } from '../src/service/logging/logger';
import { readSecrets } from '../src/service/config/schema';

afterEach(() => clearRegisteredSecrets());

describe('credential redaction', () => {
  it('redacts GitHub tokens, bearer headers and key=value secrets', () => {
    const input = [
      'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      'Authorization: Bearer abc.def.ghi-123456',
      'GOOGLE_CLIENT_SECRET=abcdabcdabcdabcd',
      'pass: "hunter22"',
      'access ya29.a0AfH6SMBxyzxyzxyz123',
      'refresh 1//0gAbCdEfGhIjKlMnOpQrStUvWx',
      'client GOCSPX-AbCdEfGhIjKlMnOp',
    ].join('\n');
    const out = redactString(input);
    expect(out).not.toMatch(/ghp_[a-z]/);
    expect(out).not.toContain('github_pat_11');
    expect(out).not.toContain('abc.def.ghi');
    expect(out).not.toContain('abcdabcdabcdabcd');
    expect(out).not.toContain('hunter22');
    expect(out).not.toContain('ya29.a0');
    expect(out).not.toContain('1//0gAbCd');
    expect(out).not.toContain('GOCSPX-AbCd');
  });

  it('redacts registered secret values anywhere', () => {
    registerSecret('s3cr3t-value-xyz');
    expect(redactString('failed with s3cr3t-value-xyz inside')).toBe('failed with [REDACTED] inside');
  });

  it('masks email addresses', () => {
    expect(maskEmail('contact reviewer1@example.com now')).toBe('contact r***@example.com now');
  });

  it('redacts secret-named fields in structured values and errors', () => {
    const value = redactValue({ githubToken: 'abc', nested: { password: 'p', ok: 'fine' }, err: new Error('Bearer zzzzzzzzzzzz') });
    expect(value).toEqual({ githubToken: '[REDACTED]', nested: { password: '[REDACTED]', ok: 'fine' }, err: { name: 'Error', message: 'Bearer [REDACTED]' } });
  });

  it('never writes secrets to log output', () => {
    const lines: string[] = [];
    registerSecret('my-api-token-1234567890');
    const logger = createLogger({ sink: (l) => lines.push(l) });
    logger.error('auth failed for ghp_abcdefghijklmnopqrstuvwxyz0123 user reviewer1@example.com', {
      token: 'whatever',
      detail: 'header my-api-token-1234567890',
    });
    const out = lines.join('\n');
    expect(out).not.toContain('ghp_abc');
    expect(out).not.toContain('whatever');
    expect(out).not.toContain('my-api-token-1234567890');
    expect(out).not.toContain('reviewer1@example.com');
    expect(JSON.parse(lines[0]!).level).toBe('error');
  });

  it('validates secrets from the environment without echoing them', () => {
    expect(() => readSecrets({ PR_REMINDER_API_TOKEN: 'short' })).toThrow(/at least 32/);
    const s = readSecrets({ PR_REMINDER_API_TOKEN: 'x'.repeat(32), GOOGLE_REFRESH_TOKEN: ' 1//abc ', GOOGLE_CLIENT_ID: '' });
    expect(s.googleRefreshToken).toBe('1//abc');
    expect(s.googleClientId).toBeUndefined();
  });
});
