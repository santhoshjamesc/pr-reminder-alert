import { type AppConfig, type AppConfigInput, parseConfig } from '../../src/service/config/schema';
import type { GitHubGateway, PrRef, PrSnapshot, RateLimitInfo } from '../../src/service/github/types';
import { GitHubAccessError, prKeyOf } from '../../src/service/github/types';
import { ChatError, type ChatTransport } from '../../src/service/chat/chatClient';
import type { WhatsAppTransport } from '../../src/service/whatsapp/whatsappWeb';

export const ME = 'octo-author';

export function makeConfig(overrides: Partial<AppConfigInput> = {}): AppConfig {
  return parseConfig({
    github: { username: ME, repositories: ['acme/widgets'], pollIntervalSeconds: 60 },
    reviewers: { 'reviewer-one': 'reviewer1@example.com', 'reviewer-two': 'reviewer2@example.com', '@acme/core': 'core-team@example.com' },
    ...overrides,
  });
}

let nextId = 1000;
export const id = () => nextId++;

export function makeSnapshot(partial: Partial<PrSnapshot> = {}): PrSnapshot {
  const number = partial.number ?? 1;
  const repo = partial.repo ?? 'acme/widgets';
  return {
    repo,
    number,
    title: 'Add sprocket support',
    body: 'Implements sprockets.',
    url: `https://github.com/${repo}/pull/${number}`,
    author: ME,
    state: 'open',
    merged: false,
    mergedAt: null,
    closedAt: null,
    draft: false,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    headSha: 'aaaaaaa1',
    headRef: 'feature/sprockets',
    headRepoMissing: false,
    labels: [],
    assignees: [],
    requestedUsers: ['reviewer-one', 'reviewer-two'],
    requestedTeams: [],
    reviews: [],
    issueComments: [],
    reviewComments: [],
    commits: [{ sha: 'aaaaaaa1', message: 'Initial', author: ME, date: '2026-10-01T08:59:00.000Z' }],
    ci: { state: 'none', failing: [] },
    ...partial,
  };
}

/** In-memory GitHub fake: tests mutate `prs` between syncs. */
export class FakeGitHub implements GitHubGateway {
  prs = new Map<string, PrSnapshot>();
  inaccessible = new Map<string, number>();
  discoverError: Error | null = null;
  fetchCount = 0;

  put(snapshot: PrSnapshot): void {
    this.prs.set(prKeyOf(snapshot), structuredClone(snapshot));
  }

  update(ref: PrRef, mutate: (s: PrSnapshot) => void): void {
    const snap = this.prs.get(prKeyOf(ref));
    if (!snap) {
      throw new Error('unknown PR');
    }
    mutate(snap);
  }

  async discoverAuthoredOpenPrs(username: string, repositories: string[]): Promise<PrRef[]> {
    if (this.discoverError) {
      throw this.discoverError;
    }
    return [...this.prs.values()]
      .filter((s) => s.state === 'open' && s.author.toLowerCase() === username.toLowerCase())
      .filter((s) => repositories.length === 0 || repositories.includes(s.repo))
      .map((s) => ({ repo: s.repo, number: s.number }));
  }

  async fetchSnapshot(ref: PrRef): Promise<PrSnapshot> {
    this.fetchCount++;
    const status = this.inaccessible.get(prKeyOf(ref));
    if (status) {
      throw new GitHubAccessError('Not Found', status);
    }
    const snap = this.prs.get(prKeyOf(ref));
    if (!snap) {
      throw new GitHubAccessError('Not Found', 404);
    }
    return structuredClone(snap);
  }

  rateLimit(): RateLimitInfo {
    return { remaining: 4999, limit: 5000, resetAt: null };
  }
}

export interface SentDm {
  /** Reviewer Workspace email the DM space belongs to. */
  to: string;
  space: string;
  text: string;
}

/** Mock Google Chat transport: records DMs, can be told to fail. Never calls Google. */
export class MockChatTransport implements ChatTransport {
  sent: SentDm[] = [];
  failures: Error[] = [];
  verifyError: Error | null = null;
  dmLookups = 0;
  private readonly spaces = new Map<string, string>();

  async findOrCreateDm(email: string): Promise<string> {
    this.dmLookups++;
    let space = this.spaces.get(email);
    if (!space) {
      space = `spaces/dm${this.spaces.size + 1}`;
      this.spaces.set(email, space);
    }
    return space;
  }

  async sendMessage(space: string, text: string): Promise<{ name: string | null }> {
    const failure = this.failures.shift();
    if (failure) {
      throw failure;
    }
    const to = [...this.spaces.entries()].find(([, s]) => s === space)?.[0] ?? '?';
    this.sent.push({ to, space, text });
    return { name: `${space}/messages/m${this.sent.length}` };
  }

  async verify(): Promise<void> {
    if (this.verifyError) {
      throw this.verifyError;
    }
  }
}

export function chatError(message: string, status: number): ChatError {
  return new ChatError(message, status === 429 || status >= 500, status);
}

/** Mock WhatsApp transport: records messages, can be unlinked or told to fail. Never opens a browser. */
export class MockWhatsApp implements WhatsAppTransport {
  linked = true;
  sent: { to: string; text: string }[] = [];
  failures: Error[] = [];

  isLinked(): boolean {
    return this.linked;
  }

  lastError(): string | null {
    return null;
  }

  activity(): string | null {
    return null;
  }

  async send(phone: string, text: string): Promise<void> {
    const failure = this.failures.shift();
    if (failure) {
      throw failure;
    }
    this.sent.push({ to: phone, text });
  }

  async link(): Promise<void> {
    this.linked = true;
  }

  async unlink(): Promise<void> {
    this.linked = false;
  }

  async close(): Promise<void> {}
}
