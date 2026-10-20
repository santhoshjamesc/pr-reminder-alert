import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { builtinGoogleClient, resolveGoogleClient } from './builtinGoogleClient';

const KEYS = {
  githubToken: 'prReminder.githubToken',
  googleClientId: 'prReminder.googleClientId',
  googleClientSecret: 'prReminder.googleClientSecret',
  googleRefreshToken: 'prReminder.googleRefreshToken',
  localApiToken: 'prReminder.localApiToken',
  remoteApiToken: 'prReminder.remoteApiToken',
} as const;

/**
 * All credentials (GitHub token, Google OAuth client + refresh token, API
 * tokens) live in VS Code SecretStorage (OS keychain). They are only
 * handed to the local service process via its environment and are never sent
 * to webviews, settings or logs.
 */
export class Secrets {
  constructor(private readonly storage: vscode.SecretStorage) {}

  onDidChange(listener: () => void): vscode.Disposable {
    return this.storage.onDidChange((e) => {
      if (Object.values(KEYS).includes(e.key as (typeof KEYS)[keyof typeof KEYS])) {
        listener();
      }
    });
  }

  getGitHubPat(): Thenable<string | undefined> {
    return this.storage.get(KEYS.githubToken);
  }

  setGitHubPat(value: string): Thenable<void> {
    return this.storage.store(KEYS.githubToken, value.trim());
  }

  /** The client is the user's own (settings / Secret Storage), else the client bundled with the extension. */
  async getGoogle(): Promise<{ clientId?: string; clientSecret?: string; refreshToken?: string }> {
    const stored = { clientId: await this.storage.get(KEYS.googleClientId), clientSecret: await this.storage.get(KEYS.googleClientSecret) };
    const settingClientId = vscode.workspace.getConfiguration('prReminder').get<string>('chat.googleClientId', '');
    return {
      ...(resolveGoogleClient(stored, builtinGoogleClient(), settingClientId) ?? { ...stored, clientId: settingClientId.trim() || stored.clientId }),
      refreshToken: await this.storage.get(KEYS.googleRefreshToken),
    };
  }

  async setGoogleClient(clientId: string, clientSecret: string): Promise<void> {
    await this.storage.store(KEYS.googleClientId, clientId.trim());
    await this.storage.store(KEYS.googleClientSecret, clientSecret.trim());
  }

  setGoogleRefreshToken(value: string): Thenable<void> {
    return this.storage.store(KEYS.googleRefreshToken, value);
  }

  /** Signs out of Google Chat (keeps the OAuth client so signing in again is one click). */
  clearGoogleSignIn(): Thenable<void> {
    return this.storage.delete(KEYS.googleRefreshToken);
  }

  getRemoteApiToken(): Thenable<string | undefined> {
    return this.storage.get(KEYS.remoteApiToken);
  }

  setRemoteApiToken(value: string): Thenable<void> {
    return this.storage.store(KEYS.remoteApiToken, value.trim());
  }

  /** Token shared by every VS Code window and the local service it starts. */
  async getOrCreateLocalApiToken(): Promise<string> {
    const existing = await this.storage.get(KEYS.localApiToken);
    if (existing && existing.length >= 32) {
      return existing;
    }
    const token = randomBytes(32).toString('hex');
    await this.storage.store(KEYS.localApiToken, token);
    return token;
  }

  async clearAll(): Promise<void> {
    for (const key of Object.values(KEYS)) {
      await this.storage.delete(key);
    }
  }
}

/** Resolves the GitHub token for the configured authentication method. */
export async function resolveGitHubToken(secrets: Secrets, method: string, interactive: boolean): Promise<string | undefined> {
  if (method === 'vscode') {
    try {
      // "repo" is required to read private repositories; VS Code's provider offers no narrower read-only scope.
      const session = await vscode.authentication.getSession('github', ['repo'], interactive ? { createIfNone: true } : { silent: true });
      return session?.accessToken;
    } catch {
      return undefined;
    }
  }
  return secrets.getGitHubPat();
}
