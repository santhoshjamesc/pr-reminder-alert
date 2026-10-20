import { safeErrorMessage } from '../../shared/redact';
import type { Logger } from '../logging/logger';
import { GoogleAuthError, type GoogleTokenProvider } from './googleAuth';

export const CHAT_API_BASE = 'https://chat.googleapis.com/v1';

/** Minimal Google Chat contract (implemented by GoogleChatTransport and by test mocks). */
export interface ChatTransport {
  /** Returns the resource name (spaces/…) of the 1:1 DM between the signed-in user and `email`, creating it if needed. */
  findOrCreateDm(email: string): Promise<string>;
  sendMessage(space: string, text: string): Promise<{ name: string | null }>;
  /** Verifies authentication without sending anything. */
  verify(): Promise<void>;
}

export class ChatError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

/** Network errors, 429 and 5xx are transient; other HTTP errors and revoked sign-ins are not. */
export function isTransientChatError(error: unknown): boolean {
  if (error instanceof ChatError || error instanceof GoogleAuthError) {
    return error.transient;
  }
  return true;
}

/** Google Chat REST API client authenticated as the user (sends DMs from the user's own account). */
export class GoogleChatTransport implements ChatTransport {
  constructor(
    private readonly tokens: GoogleTokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, retryAuth = true): Promise<{ status: number; data: T }> {
    const token = await this.tokens.getAccessToken();
    let res: Response;
    try {
      res = await this.fetchImpl(`${CHAT_API_BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new ChatError(`Google Chat request failed: ${(error as Error).message}`, true);
    }
    if (res.status === 401 && retryAuth) {
      this.tokens.invalidate();
      return this.call(method, path, body, false);
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string } };
    if (!res.ok && res.status !== 404) {
      const detail = data.error?.message ?? data.error?.status ?? `HTTP ${res.status}`;
      const hint = res.status === 403 ? ' (check the Chat API is enabled and the reviewer is in your Workspace)' : '';
      throw new ChatError(`Google Chat API error ${res.status}: ${detail}${hint}`, res.status === 429 || res.status >= 500, res.status);
    }
    return { status: res.status, data };
  }

  async findOrCreateDm(email: string): Promise<string> {
    const user = `users/${encodeURIComponent(email)}`;
    const found = await this.call<{ name?: string }>('GET', `/spaces:findDirectMessage?name=${user}`);
    if (found.status !== 404 && found.data.name) {
      return found.data.name;
    }
    const created = await this.call<{ name?: string }>('POST', '/spaces:setup', {
      space: { spaceType: 'DIRECT_MESSAGE' },
      memberships: [{ member: { name: `users/${email}`, type: 'HUMAN' } }],
    });
    if (created.status === 404 || !created.data.name) {
      throw new ChatError(`Could not open a direct message with ${email} (user not found)`, false, 404);
    }
    return created.data.name;
  }

  async sendMessage(space: string, text: string): Promise<{ name: string | null }> {
    if (!/^spaces\/[A-Za-z0-9_-]+$/.test(space)) {
      throw new ChatError('Invalid Chat space name', false);
    }
    const res = await this.call<{ name?: string }>('POST', `/${space}/messages`, { text });
    if (res.status === 404) {
      throw new ChatError('Direct message space not found', false, 404);
    }
    return { name: res.data.name ?? null };
  }

  async verify(): Promise<void> {
    await this.tokens.getAccessToken();
  }
}

export interface RetryPolicy {
  /** Immediate attempts per send call (the outbox adds longer-term retries on top). */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 1000, maxDelayMs: 15_000 };

export function backoffDelay(attempt: number, policy: Pick<RetryPolicy, 'baseDelayMs' | 'maxDelayMs'>): number {
  return Math.min(policy.baseDelayMs * 2 ** Math.max(0, attempt - 1), policy.maxDelayMs);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Sends DMs with immediate exponential-backoff retries for transient failures. */
export class ChatNotifier {
  constructor(
    private readonly transport: ChatTransport,
    private readonly logger: Logger,
    private readonly retry: RetryPolicy = DEFAULT_RETRY,
    private readonly sleep: (ms: number) => Promise<void> = realSleep,
  ) {}

  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const transient = isTransientChatError(error);
        this.logger.warn(`Google Chat ${label} failed`, { attempt, transient, error: safeErrorMessage(error) });
        if (!transient) {
          throw new ChatError(safeErrorMessage(error), false, (error as { status?: number }).status);
        }
        if (attempt < this.retry.attempts) {
          await this.sleep(backoffDelay(attempt, this.retry));
        }
      }
    }
    throw new ChatError(safeErrorMessage(lastError), true, (lastError as { status?: number }).status);
  }

  findOrCreateDm(email: string): Promise<string> {
    return this.withRetry('DM lookup', () => this.transport.findOrCreateDm(email));
  }

  send(space: string, text: string): Promise<{ name: string | null }> {
    return this.withRetry('send', () => this.transport.sendMessage(space, text));
  }

  async verify(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.transport.verify();
      return { ok: true, message: 'Signed in to Google Chat; direct messages can be sent.' };
    } catch (error) {
      return { ok: false, message: safeErrorMessage(error) };
    }
  }
}
