/**
 * Google OAuth "installed app" sign-in using a loopback redirect and PKCE.
 * Kept free of the `vscode` module so it can be unit tested; the caller opens
 * the browser. Only the refresh token is returned to the caller.
 */
import { createHash, randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { GOOGLE_CHAT_SCOPES, GOOGLE_TOKEN_URL } from '../service/chat/googleAuth';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface SignInOptions {
  clientId: string;
  clientSecret: string;
  openBrowser: (url: string) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const base64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function buildAuthUrl(clientId: string, redirectUri: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_CHAT_SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    // select_account lets the user switch Google accounts when signing in again.
    prompt: 'select_account consent',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** Turns Google's `error` redirect parameter into an actionable message. */
export function describeSignInError(error: string): string {
  switch (error) {
    case 'org_internal':
      return 'This OAuth client only allows accounts from the Google Workspace that created it. Set its audience to External in Google Cloud, or create your own client and run "Sign in to Google Chat with Your Own OAuth Client…".';
    case 'admin_policy_enforced':
      return 'Your Google Workspace admin blocks this app. Ask them to allow PR Reminder (Admin console → Security → API controls).';
    case 'access_denied':
      return 'Google sign-in was cancelled.';
    default:
      return `Google sign-in was not completed (${error})`;
  }
}

const PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>PR Reminder</title><body style="font-family:sans-serif;padding:40px"><h2>${message}</h2><p>You can close this tab and return to VS Code.</p></body>`;

export class InvalidGoogleClientError extends Error {
  constructor(readonly clientId: string) {
    super(
      `Google does not recognise the OAuth client ${clientId} (invalid_client). In Google Cloud → APIs & Services → Credentials, check the client ID and secret of your "Desktop app" client in the project where the Google Chat API is enabled. A newly created client can take a few minutes to start working.`,
    );
    this.name = 'InvalidGoogleClientError';
  }
}

/**
 * Asks Google's token endpoint whether the client exists before opening the
 * browser, because Google shows "invalid_client" there and never redirects
 * back. A dummy code gets `invalid_grant` for a valid client and
 * `invalid_client` for an unknown client or wrong secret.
 */
export async function checkGoogleClient(clientId: string, clientSecret: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: 'pr-reminder-client-check', client_id: clientId, client_secret: clientSecret, redirect_uri: 'http://127.0.0.1' }),
  }).catch(() => null); // offline: let the real sign-in report it
  const data = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
  if (data.error === 'invalid_client' || data.error === 'unauthorized_client') {
    throw new InvalidGoogleClientError(clientId);
  }
}

/** Runs the sign-in flow and resolves with the refresh token. */
export async function signInWithGoogle(options: SignInOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  await checkGoogleClient(options.clientId, options.clientSecret, fetchImpl);
  const { verifier, challenge } = createPkce();
  const state = base64url(randomBytes(16));

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Google sign-in timed out')), options.timeoutMs ?? 5 * 60_000);
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        if (url.pathname !== '/') {
          res.writeHead(404).end();
          return;
        }
        const error = url.searchParams.get('error');
        const returned = url.searchParams.get('code');
        const ok = !error && returned && url.searchParams.get('state') === state;
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE(ok ? 'Signed in to Google Chat ✔' : 'Sign-in failed'));
        clearTimeout(timer);
        if (ok) {
          resolve(returned);
        } else {
          reject(new Error(error ? describeSignInError(error) : 'Invalid sign-in response (state mismatch)'));
        }
      });
      options.openBrowser(buildAuthUrl(options.clientId, redirectUri, challenge, state)).catch(reject);
    });

    const res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        redirect_uri: redirectUri,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string; scope?: string };
    if (!res.ok || !data.refresh_token) {
      throw new Error(`Google token exchange failed${data.error ? ` (${data.error})` : ''}`);
    }
    const granted = new Set((data.scope ?? '').split(' '));
    const missing = GOOGLE_CHAT_SCOPES.filter((s) => !granted.has(s));
    if (data.scope && missing.length) {
      throw new Error(`Google sign-in did not grant all permissions: ${missing.map((s) => s.split('/').pop()).join(', ')}`);
    }
    return data.refresh_token;
  } finally {
    server.close();
    server.closeAllConnections();
  }
}
