import { describe, expect, it } from 'vitest';
import { ChatError, ChatNotifier, GoogleChatTransport, backoffDelay, isTransientChatError } from '../src/service/chat/chatClient';
import { GOOGLE_CHAT_SCOPES, GoogleAuthError, GoogleTokenProvider } from '../src/service/chat/googleAuth';
import { escapeChatText } from '../src/service/chat/templates';
import { silentLogger } from '../src/service/logging/logger';
import { builtinGoogleClient, resolveGoogleClient } from '../src/extension/builtinGoogleClient';
import { InvalidGoogleClientError, checkGoogleClient, describeSignInError, signInWithGoogle } from '../src/extension/googleOAuth';
import { chatError, makeSnapshot } from './helpers/fixtures';
import { createHarness, minutes } from './helpers/harness';

type Call = { method: string; url: string; body: string | null; auth: string | null };

/** Mocked Google endpoints: handler decides the response for each request. */
function mockFetch(handler: (call: Call) => { status?: number; body?: unknown }, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body ? String(init.body) : null,
      auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? null,
    };
    calls.push(call);
    const { status = 200, body = {} } = handler(call);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const creds = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret', refreshToken: '1//refresh' };

describe('Google OAuth token provider', () => {
  it('refreshes once and caches the access token until shortly before expiry', async () => {
    const calls: Call[] = [];
    let now = 0;
    const provider = new GoogleTokenProvider(creds, mockFetch(() => ({ body: { access_token: `ya29.tok${calls.length}`, expires_in: 3600 } }), calls), () => now);
    expect(await provider.getAccessToken()).toBe('ya29.tok1');
    expect(await provider.getAccessToken()).toBe('ya29.tok1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toContain('grant_type=refresh_token');
    now = 3600_000 - 30_000; // inside the 60 s safety window
    expect(await provider.getAccessToken()).toBe('ya29.tok2');
  });

  it('treats a revoked sign-in (invalid_grant) as permanent', async () => {
    const provider = new GoogleTokenProvider(creds, mockFetch(() => ({ status: 400, body: { error: 'invalid_grant' } })));
    const error = await provider.getAccessToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleAuthError);
    expect((error as GoogleAuthError).transient).toBe(false);
    expect((error as Error).message).toContain('Sign in to Google Chat');
  });
});

function transport(handler: (call: Call) => { status?: number; body?: unknown }, calls: Call[] = []) {
  const fetchImpl = mockFetch((c) => (c.url.includes('oauth2.googleapis.com') ? { body: { access_token: 'ya29.access', expires_in: 3600 } } : handler(c)), calls);
  return new GoogleChatTransport(new GoogleTokenProvider(creds, fetchImpl), fetchImpl);
}

describe('Google Chat REST transport', () => {
  it('finds an existing DM using the reviewer email as user alias', async () => {
    const calls: Call[] = [];
    const t = transport(() => ({ body: { name: 'spaces/AAA', spaceType: 'DIRECT_MESSAGE' } }), calls);
    expect(await t.findOrCreateDm('reviewer1@example.com')).toBe('spaces/AAA');
    const find = calls.find((c) => c.url.includes('findDirectMessage'))!;
    expect(find.url).toBe('https://chat.googleapis.com/v1/spaces:findDirectMessage?name=users/reviewer1%40example.com');
    expect(find.auth).toBe('Bearer ya29.access');
  });

  it('creates the DM with spaces.setup when none exists (404)', async () => {
    const calls: Call[] = [];
    const t = transport((c) => (c.url.includes('findDirectMessage') ? { status: 404, body: { error: { status: 'NOT_FOUND' } } } : { body: { name: 'spaces/NEW' } }), calls);
    expect(await t.findOrCreateDm('reviewer2@example.com')).toBe('spaces/NEW');
    const setup = calls.find((c) => c.url.endsWith('/spaces:setup'))!;
    expect(JSON.parse(setup.body!)).toEqual({
      space: { spaceType: 'DIRECT_MESSAGE' },
      memberships: [{ member: { name: 'users/reviewer2@example.com', type: 'HUMAN' } }],
    });
  });

  it('posts text messages to the DM space', async () => {
    const calls: Call[] = [];
    const t = transport(() => ({ body: { name: 'spaces/AAA/messages/1' } }), calls);
    expect(await t.sendMessage('spaces/AAA', 'hello')).toEqual({ name: 'spaces/AAA/messages/1' });
    const post = calls.at(-1)!;
    expect(post.method).toBe('POST');
    expect(post.url).toBe('https://chat.googleapis.com/v1/spaces/AAA/messages');
    expect(JSON.parse(post.body!)).toEqual({ text: 'hello' });
    await expect(t.sendMessage('spaces/../x', 'hi')).rejects.toBeInstanceOf(ChatError);
  });

  it('classifies 429/5xx as transient and 403 as permanent', async () => {
    const e429 = await transport(() => ({ status: 429, body: { error: { message: 'quota' } } })).sendMessage('spaces/A', 'x').catch((e: unknown) => e);
    expect(isTransientChatError(e429)).toBe(true);
    const e403 = await transport(() => ({ status: 403, body: { error: { message: 'denied' } } })).sendMessage('spaces/A', 'x').catch((e: unknown) => e);
    expect(isTransientChatError(e403)).toBe(false);
    expect((e403 as Error).message).toContain('Chat API is enabled');
  });

  it('refreshes the access token once on a 401', async () => {
    const calls: Call[] = [];
    let first = true;
    const t = transport(() => {
      if (first) {
        first = false;
        return { status: 401 };
      }
      return { body: { name: 'spaces/A/messages/2' } };
    }, calls);
    await t.sendMessage('spaces/A', 'x');
    expect(calls.filter((c) => c.url.includes('oauth2')).length).toBe(2);
  });
});

describe('ChatNotifier retries', () => {
  it('retries transient failures with exponential backoff, not permanent ones', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const flaky = {
      findOrCreateDm: async () => 'spaces/A',
      sendMessage: async () => {
        attempts++;
        if (attempts < 3) {
          throw chatError('unavailable', 503);
        }
        return { name: 'spaces/A/messages/1' };
      },
      verify: async () => undefined,
    };
    const notifier = new ChatNotifier(flaky, silentLogger, { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }, async (ms) => {
      sleeps.push(ms);
    });
    await expect(notifier.send('spaces/A', 'x')).resolves.toEqual({ name: 'spaces/A/messages/1' });
    expect(sleeps).toEqual([100, 200]);

    let denied = 0;
    const forbidden = { ...flaky, sendMessage: async () => (denied++, Promise.reject(chatError('denied', 403))) };
    const n2 = new ChatNotifier(forbidden, silentLogger, { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 }, async () => undefined);
    await expect(n2.send('spaces/A', 'x')).rejects.toMatchObject({ transient: false });
    expect(denied).toBe(1);
  });

  it('computes capped exponential backoff', () => {
    expect([1, 2, 3, 4].map((n) => backoffDelay(n, { baseDelayMs: 1000, maxDelayMs: 5000 }))).toEqual([1000, 2000, 4000, 5000]);
  });
});

describe('outbox delivery failures', () => {
  const T0 = new Date('2026-10-01T08:00:00.000Z');
  const T1 = new Date('2026-10-01T09:01:00.000Z');

  it('re-queues transient failures with backoff, then marks them failed and allows manual retry', async () => {
    const h = createHarness();
    await h.cycle(T0);
    h.github.put(makeSnapshot({ requestedUsers: ['reviewer-one'] }));
    h.transport.failures = Array.from({ length: 5 }, () => chatError('backend error', 503));
    await h.cycle(T1);
    let row = h.store.outbox.list()[0]!;
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).toBe(minutes(T1, 1).toISOString());
    for (const at of [1, 3, 7, 15]) {
      await h.reminders.tick(minutes(T1, at));
    }
    row = h.store.outbox.list()[0]!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(5);
    expect(row.last_error).toContain('backend error');
    expect(h.transport.sent).toHaveLength(0);

    expect(h.store.outbox.requeueFailed('all', minutes(T1, 16))).toBe(1);
    await h.sync.sync(minutes(T1, 16));
    await h.reminders.tick(minutes(T1, 16));
    expect(h.transport.sent).toHaveLength(1);
    expect(h.store.outbox.list()[0]!.status).toBe('sent');
  });

  it('clears failed messages without re-sending them', async () => {
    const h = createHarness();
    await h.cycle(T0);
    h.github.put(makeSnapshot({ requestedUsers: ['reviewer-one'] }));
    h.transport.failures = [chatError('user not in domain', 403)];
    await h.cycle(T1);
    expect(h.store.outbox.list()[0]!.status).toBe('failed');

    expect(h.store.outbox.dismissFailed('all')).toBe(1);
    expect(h.store.outbox.count('failed')).toBe(0);
    expect(h.store.outbox.list()[0]!.status).toBe('cancelled');
    await h.cycle(minutes(T1, 5));
    expect(h.transport.sent).toHaveLength(0);
    expect(h.store.outbox.list()).toHaveLength(1);
  });

  it('marks permanent failures failed immediately', async () => {
    const h = createHarness();
    await h.cycle(T0);
    h.github.put(makeSnapshot({ requestedUsers: ['reviewer-one'] }));
    h.transport.failures = [chatError('user not in domain', 403)];
    await h.cycle(T1);
    expect(h.store.outbox.list()[0]!.status).toBe('failed');
  });

  it('forgets a cached DM space that no longer exists and looks it up again', async () => {
    const h = createHarness();
    await h.cycle(T0);
    h.github.put(makeSnapshot({ requestedUsers: ['reviewer-one'] }));
    h.store.chatSpaces.set('reviewer1@example.com', 'spaces/stale');
    h.transport.failures = [chatError('space gone', 404)];
    await h.cycle(T1);
    expect(h.store.chatSpaces.get('reviewer1@example.com')).toBeNull();
    await h.cycle(minutes(T1, 1));
    expect(h.transport.sent).toHaveLength(1);
    expect(h.store.chatSpaces.get('reviewer1@example.com')).toBe(h.transport.sent[0]!.space);
  });
});

describe('Chat text escaping', () => {
  it('neutralises links, mentions and formatting', () => {
    expect(escapeChatText('<users/all> *b* _i_ ~s~ `c`')).toBe('‹users/all› ∗b∗ ˍiˍ ∼s∼ ˋcˋ');
  });
});

describe('Google sign-in (loopback + PKCE)', () => {
  it('completes the flow and returns the refresh token', async () => {
    const tokenCalls: Call[] = [];
    const fetchImpl = mockFetch(() => ({ body: { refresh_token: '1//new-refresh', access_token: 'ya29.x', scope: GOOGLE_CHAT_SCOPES.join(' ') } }), tokenCalls);
    const token = await signInWithGoogle({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      fetchImpl,
      // Simulated browser: Google redirects back to the loopback URL with a code.
      openBrowser: async (url) => {
        const auth = new URL(url);
        expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
        expect(auth.searchParams.get('access_type')).toBe('offline');
        expect(auth.searchParams.get('scope')).toBe(GOOGLE_CHAT_SCOPES.join(' '));
        const redirect = new URL(auth.searchParams.get('redirect_uri')!);
        expect(redirect.hostname).toBe('127.0.0.1');
        redirect.searchParams.set('code', 'auth-code');
        redirect.searchParams.set('state', auth.searchParams.get('state')!);
        await fetch(redirect);
      },
    });
    expect(token).toBe('1//new-refresh');
    expect(tokenCalls).toHaveLength(2); // client check, then the code exchange
    const body = new URLSearchParams(tokenCalls[1]!.body!);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rejects a redirect with the wrong state', async () => {
    const result = signInWithGoogle({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      fetchImpl: mockFetch(() => ({ body: {} })),
      openBrowser: async (url) => {
        const redirect = new URL(new URL(url).searchParams.get('redirect_uri')!);
        redirect.searchParams.set('code', 'x');
        redirect.searchParams.set('state', 'forged');
        await fetch(redirect).catch(() => undefined);
      },
    });
    await expect(result).rejects.toThrow(/state mismatch/);
  });

  it('reports an unknown OAuth client before opening the browser', async () => {
    let opened = false;
    const result = signInWithGoogle({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      fetchImpl: mockFetch(() => ({ status: 401, body: { error: 'invalid_client', error_description: 'The OAuth client was not found.' } })),
      openBrowser: async () => {
        opened = true;
      },
    });
    await expect(result).rejects.toBeInstanceOf(InvalidGoogleClientError);
    await expect(result).rejects.toThrow(/cid\.apps\.googleusercontent\.com/);
    expect(opened).toBe(false);
  });

  it('accepts a known client (dummy code is rejected with invalid_grant)', async () => {
    const calls: Call[] = [];
    await expect(checkGoogleClient(creds.clientId, creds.clientSecret, mockFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }), calls))).resolves.toBeUndefined();
    expect(new URLSearchParams(calls[0]!.body!).get('client_id')).toBe(creds.clientId);
  });

  it('does not block sign-in when the client check cannot reach Google', async () => {
    const offline = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    await expect(checkGoogleClient(creds.clientId, creds.clientSecret, offline)).resolves.toBeUndefined();
  });
});

describe('built-in Google OAuth client', () => {
  const builtin = { clientId: 'builtin.apps.googleusercontent.com', clientSecret: 'GOCSPX-builtin' };

  it('is absent when the build did not inject one', () => {
    expect(builtinGoogleClient()).toBeNull();
  });

  it('prefers a client the user entered, then the built-in one', () => {
    expect(resolveGoogleClient({ clientId: 'mine.apps.googleusercontent.com', clientSecret: 'GOCSPX-mine' }, builtin)).toEqual({
      clientId: 'mine.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-mine',
    });
    expect(resolveGoogleClient({ clientId: 'mine.apps.googleusercontent.com' }, builtin)).toEqual(builtin);
    expect(resolveGoogleClient({}, builtin)).toEqual(builtin);
    expect(resolveGoogleClient({}, null)).toBeNull();
  });

  it('uses the client ID from settings with the stored secret', () => {
    const stored = { clientId: 'old.apps.googleusercontent.com', clientSecret: 'GOCSPX-mine' };
    expect(resolveGoogleClient(stored, builtin, ' team.apps.googleusercontent.com ')).toEqual({ clientId: 'team.apps.googleusercontent.com', clientSecret: 'GOCSPX-mine' });
    expect(resolveGoogleClient({}, builtin, 'team.apps.googleusercontent.com')).toEqual(builtin);
    expect(resolveGoogleClient({}, null, 'team.apps.googleusercontent.com')).toBeNull();
  });

  it('explains Workspace restrictions on sign-in', () => {
    expect(describeSignInError('org_internal')).toMatch(/External/);
    expect(describeSignInError('admin_policy_enforced')).toMatch(/admin/);
    expect(describeSignInError('weird')).toBe('Google sign-in was not completed (weird)');
  });
});
