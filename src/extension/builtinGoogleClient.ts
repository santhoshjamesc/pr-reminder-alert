/**
 * The Google OAuth client (type "Desktop app") bundled with the extension, so
 * users only have to click "Allow". Injected by esbuild from the
 * PR_REMINDER_GOOGLE_CLIENT_ID / PR_REMINDER_GOOGLE_CLIENT_SECRET environment
 * variables; empty in builds without them. Google treats installed-app client
 * secrets as non-confidential, and sign-in uses PKCE.
 */
declare const __PR_GOOGLE_CLIENT_ID__: string | undefined;
declare const __PR_GOOGLE_CLIENT_SECRET__: string | undefined;

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

export function builtinGoogleClient(): GoogleClient | null {
  const clientId = typeof __PR_GOOGLE_CLIENT_ID__ === 'string' ? __PR_GOOGLE_CLIENT_ID__.trim() : '';
  const clientSecret = typeof __PR_GOOGLE_CLIENT_SECRET__ === 'string' ? __PR_GOOGLE_CLIENT_SECRET__.trim() : '';
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Picks the OAuth client: the ID from settings with the stored secret, then the
 * stored client, then the built-in one; null means the user must enter one.
 */
export function resolveGoogleClient(stored: Partial<GoogleClient>, builtin: GoogleClient | null, settingClientId = ''): GoogleClient | null {
  const clientId = settingClientId.trim() || stored.clientId;
  if (clientId && stored.clientSecret) {
    return { clientId, clientSecret: stored.clientSecret };
  }
  return builtin;
}
