import type { CiState } from '../../shared/protocol';

export interface PrRef {
  repo: string; // owner/name
  number: number;
}

export interface ReviewSnapshot {
  id: number;
  user: string;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  body: string;
  submittedAt: string | null;
  url: string;
  commitId: string | null;
}

export interface CommentSnapshot {
  id: number;
  user: string;
  body: string;
  createdAt: string;
  url: string;
  /** Present for inline review comments. */
  path?: string;
  /** Review that contains this inline comment. */
  reviewId?: number;
}

export interface CommitSnapshot {
  sha: string;
  message: string;
  author: string | null;
  date: string | null;
}

export interface CiSnapshot {
  state: CiState;
  failing: string[];
}

export interface PrSnapshot {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  closedAt: string | null;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  headSha: string;
  headRef: string;
  /** True when the head branch / fork no longer exists. */
  headRepoMissing: boolean;
  labels: string[];
  assignees: string[];
  requestedUsers: string[];
  /** Team reviewers as "@org/team-slug". */
  requestedTeams: string[];
  reviews: ReviewSnapshot[];
  issueComments: CommentSnapshot[];
  reviewComments: CommentSnapshot[];
  commits: CommitSnapshot[];
  ci: CiSnapshot;
}

export interface RateLimitInfo {
  remaining: number | null;
  limit: number | null;
  resetAt: string | null;
}

/** Abstraction over the GitHub REST API so the sync engine can be tested with fakes. */
export interface GitHubGateway {
  /** Lists open PRs authored by `username` in `repositories` (or everywhere the token can see if empty). */
  discoverAuthoredOpenPrs(username: string, repositories: string[]): Promise<PrRef[]>;
  /** Fetches the full state of one PR. Throws GitHubAccessError for 404/403/410. */
  fetchSnapshot(ref: PrRef): Promise<PrSnapshot>;
  rateLimit(): RateLimitInfo;
}

export class GitHubAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubAccessError';
  }
}

export class GitHubTransientError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GitHubTransientError';
  }
}

export function prKeyOf(ref: PrRef): string {
  return `${ref.repo}#${ref.number}`;
}

/** Keeps only pull requests whose author matches the configured username (case-insensitive). */
export function filterAuthoredBy<T extends { author: string | null | undefined }>(items: T[], username: string): T[] {
  const wanted = username.toLowerCase();
  return items.filter((item) => (item.author ?? '').toLowerCase() === wanted);
}
