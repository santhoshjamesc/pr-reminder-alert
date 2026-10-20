/** OAuth scopes used to DM reviewers as the signed-in user (user authentication). */
export const GOOGLE_CHAT_SCOPES = [
  'https://www.googleapis.com/auth/chat.spaces.readonly', // spaces.findDirectMessage
  'https://www.googleapis.com/auth/chat.spaces.create', // spaces.setup (create a DM)
  'https://www.googleapis.com/auth/chat.messages.create', // spaces.messages.create
];

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

/** Exchanges the stored refresh token for short-lived access tokens and caches them. */
export class GoogleTokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly credentials: GoogleCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > this.now()) {
      return this.cached.token;
    }
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Forces the next call to fetch a fresh token (e.g. after a 401). */
  invalidate(): void {
    this.cached = null;
  }

  private async refresh(): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.credentials.clientId,
          client_secret: this.credentials.clientSecret,
          refresh_token: this.credentials.refreshToken,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new GoogleAuthError(`Could not reach Google OAuth: ${(error as Error).message}`, true);
    }
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
      if (data.error === 'invalid_client' || data.error === 'unauthorized_client') {
        throw new GoogleAuthError(`Google rejected the OAuth client (${data.error}): check the client ID and secret, then sign in to Google Chat again.`, false);
      }
      if (data.error === 'invalid_grant') {
        throw new GoogleAuthError(`Google sign-in is no longer valid (${data.error}). Run "PR Reminder: Sign in to Google Chat" again.`, false);
      }
      throw new GoogleAuthError(`Google token refresh failed (HTTP ${res.status}${data.error ? `, ${data.error}` : ''})`, res.status >= 500 || res.status === 429);
    }
    this.cached = { token: data.access_token, expiresAt: this.now() + (data.expires_in ?? 3600) * 1000 };
    return data.access_token;
  }
}
