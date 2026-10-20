import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import type { Logger } from '../logging/logger';
import { combineCiState } from './ci';
import {
  type CommentSnapshot,
  type GitHubGateway,
  type PrRef,
  type PrSnapshot,
  type RateLimitInfo,
  GitHubAccessError,
  GitHubTransientError,
  filterAuthoredBy,
} from './types';

const ResilientOctokit = Octokit.plugin(throttling, retry);
type ResilientOctokitInstance = InstanceType<typeof ResilientOctokit>;

export interface OctokitGatewayOptions {
  token: string;
  baseUrl?: string;
  logger: Logger;
  /** Injected for tests (mocked GitHub API responses). */
  fetch?: typeof globalThis.fetch;
  /** Disable plugin-level retries (tests). */
  retries?: number;
  maxCommits?: number;
}

/**
 * GitHub REST implementation of the gateway. Only read endpoints are used:
 * the service never approves, merges or modifies pull requests.
 */
export class OctokitGateway implements GitHubGateway {
  private readonly octokit: ResilientOctokitInstance;
  private readonly logger: Logger;
  private readonly maxCommits: number;
  private rate: RateLimitInfo = { remaining: null, limit: null, resetAt: null };
  private checksForbidden = new Set<string>();

  constructor(options: OctokitGatewayOptions) {
    this.logger = options.logger.child({ component: 'github' });
    this.maxCommits = options.maxCommits ?? 250;
    const retries = options.retries ?? 3;
    this.octokit = new ResilientOctokit({
      auth: options.token,
      baseUrl: options.baseUrl,
      userAgent: 'pr-reminder-alert/0.1',
      // Route Octokit's own logging through the structured, redacting logger.
      log: {
        debug: (msg: string) => this.logger.debug(msg),
        info: (msg: string) => this.logger.debug(msg),
        warn: (msg: string) => this.logger.warn(msg),
        error: (msg: string) => this.logger.debug(msg),
      },
      request: options.fetch ? { fetch: options.fetch } : undefined,
      retry: { doNotRetry: [400, 401, 403, 404, 410, 422, 451], retries },
      throttle: {
        enabled: retries > 0,
        onRateLimit: (retryAfter, opts, _octokit, retryCount) => {
          this.logger.warn('GitHub primary rate limit hit', { retryAfter, url: (opts as { url?: string }).url });
          return retryCount < 1 && retryAfter <= 60;
        },
        onSecondaryRateLimit: (retryAfter, opts, _octokit, retryCount) => {
          this.logger.warn('GitHub secondary rate limit hit', { retryAfter, url: (opts as { url?: string }).url });
          return retryCount < 1 && retryAfter <= 60;
        },
      },
    });
    this.octokit.hook.after('request', (response) => {
      this.captureRateLimit(response.headers as Record<string, string | number | undefined>);
    });
    this.octokit.hook.error('request', (error) => {
      const headers = (error as { response?: { headers?: Record<string, string | number | undefined> } }).response?.headers;
      if (headers) {
        this.captureRateLimit(headers);
      }
      throw error;
    });
  }

  rateLimit(): RateLimitInfo {
    return { ...this.rate };
  }

  async discoverAuthoredOpenPrs(username: string, repositories: string[]): Promise<PrRef[]> {
    return this.wrap(async () => {
      if (repositories.length === 0) {
        return this.searchAuthored(username);
      }
      const refs: PrRef[] = [];
      for (const repo of repositories) {
        const [owner, name] = splitRepo(repo);
        try {
          const pulls = await this.octokit.paginate(this.octokit.rest.pulls.list, { owner, repo: name, state: 'open', per_page: 100 });
          const mine = filterAuthoredBy(
            pulls.map((p) => ({ number: p.number, author: p.user?.login ?? null })),
            username,
          );
          refs.push(...mine.map((p) => ({ repo, number: p.number })));
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (status === 404 || status === 403) {
            // Permission loss or deleted repository: keep syncing other repositories.
            this.logger.warn('Cannot list pull requests for repository', { repo, status });
            continue;
          }
          throw error;
        }
      }
      return refs;
    });
  }

  private async searchAuthored(username: string): Promise<PrRef[]> {
    const items = await this.octokit.paginate(this.octokit.rest.search.issuesAndPullRequests, {
      q: `is:pr is:open archived:false author:${username}`,
      per_page: 100,
      advanced_search: 'true',
    } as Parameters<typeof this.octokit.rest.search.issuesAndPullRequests>[0]);
    const mapped = items
      .filter((i) => i.pull_request)
      .map((i) => ({ repo: repoFromApiUrl(i.repository_url), number: i.number, author: i.user?.login ?? null }));
    return filterAuthoredBy(mapped, username).map(({ repo, number }) => ({ repo, number }));
  }

  async fetchSnapshot(ref: PrRef): Promise<PrSnapshot> {
    return this.wrap(async () => {
      const [owner, repo] = splitRepo(ref.repo);
      const base = { owner, repo, pull_number: ref.number };
      const { data: pr } = await this.octokit.rest.pulls.get(base);

      const [reviews, issueComments, reviewComments, commits] = await Promise.all([
        this.octokit.paginate(this.octokit.rest.pulls.listReviews, { ...base, per_page: 100 }),
        this.octokit.paginate(this.octokit.rest.issues.listComments, { owner, repo, issue_number: ref.number, per_page: 100 }),
        this.octokit.paginate(this.octokit.rest.pulls.listReviewComments, { ...base, per_page: 100 }),
        this.listCommits(base),
      ]);
      const ci = await this.fetchCi(ref.repo, owner, repo, pr.head.sha);

      return {
        repo: ref.repo,
        number: pr.number,
        title: pr.title,
        body: pr.body ?? '',
        url: pr.html_url,
        author: pr.user?.login ?? '',
        state: pr.state === 'open' ? 'open' : 'closed',
        merged: Boolean(pr.merged || pr.merged_at),
        mergedAt: pr.merged_at ?? null,
        closedAt: pr.closed_at ?? null,
        draft: Boolean(pr.draft),
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        headSha: pr.head.sha,
        headRef: pr.head.ref,
        headRepoMissing: pr.head.repo === null,
        labels: (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
        assignees: (pr.assignees ?? []).map((a) => a.login),
        requestedUsers: (pr.requested_reviewers ?? []).map((u) => u.login),
        requestedTeams: (pr.requested_teams ?? []).map((t) => `@${owner}/${t.slug}`),
        reviews: reviews.map((r) => ({
          id: r.id,
          user: r.user?.login ?? '',
          state: r.state,
          body: r.body ?? '',
          submittedAt: r.submitted_at ?? null,
          url: r.html_url,
          commitId: r.commit_id ?? null,
        })),
        issueComments: issueComments.map(
          (c): CommentSnapshot => ({ id: c.id, user: c.user?.login ?? '', body: c.body ?? '', createdAt: c.created_at, url: c.html_url }),
        ),
        reviewComments: reviewComments.map(
          (c): CommentSnapshot => ({
            id: c.id,
            user: c.user?.login ?? '',
            body: c.body,
            createdAt: c.created_at,
            url: c.html_url,
            path: c.path,
            reviewId: c.pull_request_review_id ?? undefined,
          }),
        ),
        commits,
        ci,
      };
    });
  }

  private async listCommits(base: { owner: string; repo: string; pull_number: number }) {
    const out: PrSnapshot['commits'] = [];
    for await (const page of this.octokit.paginate.iterator(this.octokit.rest.pulls.listCommits, { ...base, per_page: 100 })) {
      for (const c of page.data) {
        out.push({
          sha: c.sha,
          message: c.commit.message.split('\n')[0] ?? '',
          author: c.author?.login ?? c.commit.author?.name ?? null,
          date: c.commit.committer?.date ?? c.commit.author?.date ?? null,
        });
      }
      if (out.length >= this.maxCommits) {
        break;
      }
    }
    return out;
  }

  private async fetchCi(fullRepo: string, owner: string, repo: string, sha: string) {
    let checkRuns: { name: string; status: string; conclusion: string | null }[] = [];
    if (!this.checksForbidden.has(fullRepo)) {
      try {
        const { data } = await this.octokit.rest.checks.listForRef({ owner, repo, ref: sha, per_page: 100 });
        checkRuns = data.check_runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion }));
      } catch (error) {
        if ((error as { status?: number }).status === 403) {
          // Fine-grained tokens without "Checks: read" - fall back to commit statuses only.
          this.checksForbidden.add(fullRepo);
          this.logger.warn('Token cannot read check runs; using commit statuses only', { repo: fullRepo });
        } else {
          throw error;
        }
      }
    }
    let statuses: { context: string; state: string }[] = [];
    try {
      const { data } = await this.octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: sha, per_page: 100 });
      statuses = data.statuses.map((s) => ({ context: s.context, state: s.state }));
    } catch (error) {
      if ((error as { status?: number }).status !== 403) {
        throw error;
      }
    }
    return combineCiState(checkRuns, statuses);
  }

  private captureRateLimit(headers: Record<string, string | number | undefined>): void {
    const remaining = headers['x-ratelimit-remaining'];
    const limit = headers['x-ratelimit-limit'];
    const reset = headers['x-ratelimit-reset'];
    if (remaining !== undefined) {
      this.rate = {
        remaining: Number(remaining),
        limit: limit !== undefined ? Number(limit) : this.rate.limit,
        resetAt: reset !== undefined ? new Date(Number(reset) * 1000).toISOString() : this.rate.resetAt,
      };
    }
  }

  /** Normalises Octokit errors into access (permanent) vs transient errors. */
  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw classifyGitHubError(error);
    }
  }
}

export function classifyGitHubError(error: unknown): Error {
  if (error instanceof GitHubAccessError || error instanceof GitHubTransientError) {
    return error;
  }
  const status = (error as { status?: number }).status;
  const headers = (error as { response?: { headers?: Record<string, string> } }).response?.headers ?? {};
  const message = error instanceof Error ? error.message : String(error);
  if (status === 403 || status === 429) {
    const isRateLimit = headers['x-ratelimit-remaining'] === '0' || status === 429 || /rate limit/i.test(message);
    if (isRateLimit) {
      const reset = Number(headers['x-ratelimit-reset']);
      const retryAfter = Number(headers['retry-after']);
      const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Number.isFinite(reset) && reset > 0
          ? Math.max(reset * 1000 - Date.now(), 1000)
          : 60_000;
      return new GitHubTransientError(`GitHub rate limit exceeded: ${message}`, retryAfterMs);
    }
    return new GitHubAccessError(`GitHub permission denied: ${message}`, 403);
  }
  if (status === 401) {
    return new GitHubAccessError('GitHub authentication failed (token invalid, expired or revoked)', 401);
  }
  if (status === 404 || status === 410) {
    return new GitHubAccessError(`GitHub resource not found: ${message}`, status);
  }
  return new GitHubTransientError(`GitHub request failed: ${message}`);
}

function splitRepo(repo: string): [string, string] {
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    throw new GitHubAccessError(`Invalid repository name: ${repo}`, 400);
  }
  return [owner, name];
}

function repoFromApiUrl(url: string): string {
  // https://api.github.com/repos/{owner}/{repo}
  const match = /\/repos\/([^/]+)\/([^/]+)$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : url;
}
