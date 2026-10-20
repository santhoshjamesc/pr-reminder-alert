import { describe, expect, it } from 'vitest';
import { combineCiState } from '../src/service/github/ci';
import { OctokitGateway, classifyGitHubError } from '../src/service/github/octokitGateway';
import { GitHubAccessError, GitHubTransientError, filterAuthoredBy } from '../src/service/github/types';
import { silentLogger } from '../src/service/logging/logger';

type Route = { status?: number; body: unknown; headers?: Record<string, string> };

/** Mocked GitHub REST API: maps "METHOD /path?query" prefixes to canned responses. */
function mockFetch(routes: Record<string, Route>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    calls.push(`${key}${url.search}`);
    const route = routes[key];
    const response = route
      ? new Response(JSON.stringify(route.body), {
          status: route.status ?? 200,
          headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4990', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1790000000', ...route.headers },
        })
      : new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    // Real fetch responses carry their URL; Octokit's paginator relies on it.
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  }) as typeof fetch;
}

const user = (login: string) => ({ login, id: 1 });

function gateway(routes: Record<string, Route>, calls?: string[]) {
  return new OctokitGateway({ token: 'test-token', logger: silentLogger, fetch: mockFetch(routes, calls), retries: 0 });
}

describe('PR author filtering', () => {
  it('keeps only PRs authored by the configured user (case-insensitive)', () => {
    const items = [{ author: 'Octo-Author' }, { author: 'someone-else' }, { author: null }, { author: 'octo-author' }];
    expect(filterAuthoredBy(items, 'octo-author')).toHaveLength(2);
  });

  it('lists open PRs per repository and filters by author', async () => {
    const g = gateway({
      'GET /repos/acme/widgets/pulls': {
        body: [
          { number: 1, user: user('octo-author') },
          { number: 2, user: user('someone-else') },
          { number: 3, user: user('OCTO-AUTHOR') },
        ],
      },
    });
    expect(await g.discoverAuthoredOpenPrs('octo-author', ['acme/widgets'])).toEqual([
      { repo: 'acme/widgets', number: 1 },
      { repo: 'acme/widgets', number: 3 },
    ]);
    expect(g.rateLimit().remaining).toBe(4990);
  });

  it('searches all accessible repositories when none are configured', async () => {
    const calls: string[] = [];
    const g = gateway(
      {
        'GET /search/issues': {
          body: {
            total_count: 2,
            items: [
              { number: 7, pull_request: {}, repository_url: 'https://api.github.com/repos/org/api', user: user('octo-author') },
              { number: 8, pull_request: {}, repository_url: 'https://api.github.com/repos/org/web', user: user('intruder') },
            ],
          },
        },
      },
      calls,
    );
    expect(await g.discoverAuthoredOpenPrs('octo-author', [])).toEqual([{ repo: 'org/api', number: 7 }]);
    expect(decodeURIComponent(calls[0]!)).toContain('author:octo-author');
  });

  it('skips repositories that are no longer accessible', async () => {
    const g = gateway({ 'GET /repos/acme/widgets/pulls': { body: [{ number: 1, user: user('octo-author') }] } });
    expect(await g.discoverAuthoredOpenPrs('octo-author', ['acme/gone', 'acme/widgets'])).toEqual([{ repo: 'acme/widgets', number: 1 }]);
  });
});

describe('PR snapshot mapping', () => {
  it('maps pulls, reviews, comments, commits and CI into a snapshot', async () => {
    const base = '/repos/acme/widgets';
    const g = gateway({
      [`GET ${base}/pulls/5`]: {
        body: {
          number: 5,
          title: 'T',
          body: null,
          html_url: 'https://github.com/acme/widgets/pull/5',
          user: user('octo-author'),
          state: 'open',
          merged: false,
          merged_at: null,
          closed_at: null,
          draft: false,
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-01T01:00:00Z',
          head: { sha: 'abc', ref: 'feat', repo: null },
          labels: [{ name: 'bug' }],
          assignees: [user('octo-author')],
          requested_reviewers: [user('reviewer-one')],
          requested_teams: [{ slug: 'core' }],
        },
      },
      [`GET ${base}/pulls/5/reviews`]: {
        body: [{ id: 9, user: user('reviewer-two'), state: 'APPROVED', body: 'lgtm', submitted_at: '2026-10-01T02:00:00Z', html_url: 'u', commit_id: 'abc' }],
      },
      [`GET ${base}/issues/5/comments`]: { body: [{ id: 10, user: user('x'), body: 'hi', created_at: '2026-10-01T02:00:00Z', html_url: 'c10' }] },
      [`GET ${base}/pulls/5/comments`]: {
        body: [{ id: 11, user: user('y'), body: 'nit', created_at: '2026-10-01T02:00:00Z', html_url: 'c11', path: 'a.ts', pull_request_review_id: 9 }],
      },
      [`GET ${base}/pulls/5/commits`]: { body: [{ sha: 'abc', commit: { message: 'first line\nmore', author: { name: 'A', date: 'd' } }, author: user('octo-author') }] },
      [`GET ${base}/commits/abc/check-runs`]: { body: { total_count: 1, check_runs: [{ name: 'build', status: 'completed', conclusion: 'failure' }] } },
      [`GET ${base}/commits/abc/status`]: { body: { state: 'success', statuses: [{ context: 'lint', state: 'success' }] } },
    });
    const snap = await g.fetchSnapshot({ repo: 'acme/widgets', number: 5 });
    expect(snap).toMatchObject({
      body: '',
      headRepoMissing: true,
      labels: ['bug'],
      requestedUsers: ['reviewer-one'],
      requestedTeams: ['@acme/core'],
      reviews: [{ id: 9, user: 'reviewer-two', state: 'APPROVED', body: 'lgtm' }],
      reviewComments: [{ id: 11, path: 'a.ts', reviewId: 9 }],
      commits: [{ sha: 'abc', message: 'first line', author: 'octo-author' }],
      ci: { state: 'failure', failing: ['build'] },
    });
  });

  it('turns 404s into access errors (deleted PR / permission loss)', async () => {
    const g = gateway({});
    await expect(g.fetchSnapshot({ repo: 'acme/widgets', number: 404 })).rejects.toBeInstanceOf(GitHubAccessError);
  });

  it('treats rate limiting as transient with a retry-after', () => {
    const error = classifyGitHubError(
      Object.assign(new Error('API rate limit exceeded'), { status: 403, response: { headers: { 'x-ratelimit-remaining': '0', 'retry-after': '30' } } }),
    );
    expect(error).toBeInstanceOf(GitHubTransientError);
    expect((error as GitHubTransientError).retryAfterMs).toBe(30_000);
    expect(classifyGitHubError(Object.assign(new Error('Bad credentials'), { status: 401 }))).toBeInstanceOf(GitHubAccessError);
    expect(classifyGitHubError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBeInstanceOf(GitHubTransientError);
  });
});

describe('CI state', () => {
  it('combines check runs and commit statuses', () => {
    expect(combineCiState([], []).state).toBe('none');
    expect(combineCiState([{ name: 'a', status: 'in_progress', conclusion: null }], []).state).toBe('pending');
    expect(combineCiState([{ name: 'a', status: 'completed', conclusion: 'success' }], [{ context: 'b', state: 'success' }]).state).toBe('success');
    expect(combineCiState([{ name: 'a', status: 'completed', conclusion: 'skipped' }], [{ context: 'b', state: 'error' }])).toEqual({ state: 'failure', failing: ['b'] });
  });
});
