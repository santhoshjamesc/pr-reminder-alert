import { describe, expect, it } from 'vitest';
import { makeConfig, makeSnapshot } from './helpers/fixtures';
import { createHarness, minutes } from './helpers/harness';

const T0 = new Date('2026-10-01T08:00:00.000Z');
const T1 = new Date('2026-10-01T09:01:00.000Z');
const PR = { repo: 'acme/widgets', number: 1 };

describe('historical event suppression', () => {
  it('records events from the first synchronization as a baseline without alerting', async () => {
    const h = createHarness();
    h.github.put(
      makeSnapshot({
        reviews: [{ id: 1, user: 'reviewer-one', state: 'APPROVED', body: '', submittedAt: '2026-09-30T10:00:00Z', url: '', commitId: null }],
        issueComments: [{ id: 2, user: 'someone', body: 'old', createdAt: '2026-09-30T10:00:00Z', url: 'https://github.com/c/2' }],
        ci: { state: 'failure', failing: ['build'] },
      }),
    );
    const result = await h.sync.sync(new Date('2026-10-02T00:00:00Z'));
    expect(result.baselineCompleted).toBe(true);
    expect(result.newEvents).toHaveLength(0);
    const stored = h.store.events.list({ includeHistorical: true });
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((e) => e.historical === 1 && e.acknowledged_at !== null)).toBe(true);
    expect(h.store.events.countUnacknowledged()).toBe(0);
    // Existing PRs do not get "review requested" emails unless configured.
    await h.reminders.tick(new Date('2026-10-02T00:00:00Z'));
    expect(h.transport.sent).toHaveLength(0);
  });

  it('can alert on historical events when explicitly requested', async () => {
    const h = createHarness({ config: makeConfig({ alerts: { alertOnHistorical: true } }) });
    h.github.put(makeSnapshot());
    const result = await h.sync.sync(T1);
    expect(result.newEvents.map((e) => e.type)).toContain('pr_opened');
  });

  it('treats PRs from a newly added repository that pre-date monitoring as historical', async () => {
    const h = createHarness();
    await h.cycle(T0);
    h.github.put(makeSnapshot({ repo: 'acme/gears', createdAt: '2026-09-01T00:00:00Z' }));
    h.setConfig(makeConfig({ github: { username: 'octo-author', repositories: ['acme/widgets', 'acme/gears'] } }));
    const result = await h.sync.sync(T1);
    expect(result.newEvents).toHaveLength(0);
  });

  it('alerts on new activity after the baseline', async () => {
    const h = createHarness();
    h.github.put(makeSnapshot());
    await h.sync.sync(T0);
    h.github.update(PR, (s) => {
      s.reviews.push({ id: 5, user: 'reviewer-one', state: 'CHANGES_REQUESTED', body: 'no', submittedAt: T1.toISOString(), url: 'https://github.com/r/5', commitId: null });
      s.ci = { state: 'failure', failing: ['unit-tests'] };
      s.state = 'open';
    });
    const result = await h.sync.sync(T1);
    const types = result.newEvents.map((e) => e.type).sort();
    expect(types).toEqual(['changes_requested', 'ci_failed']);
    const ci = result.newEvents.find((e) => e.type === 'ci_failed')!;
    expect(ci.severity).toBe('high');
    expect(ci.summary).toContain('unit-tests');
    expect(ci.url).toBe('https://github.com/acme/widgets/pull/1/checks');
  });
});

describe('duplicate event suppression', () => {
  it('never produces the same event twice, including across repeated syncs', async () => {
    const h = createHarness();
    await h.sync.sync(T0);
    h.github.put(makeSnapshot());
    const first = await h.sync.sync(T1);
    expect(first.newEvents.map((e) => e.type)).toContain('pr_opened');
    h.github.update(PR, (s) => {
      s.issueComments.push({ id: 9, user: 'someone', body: 'hello', createdAt: T1.toISOString(), url: 'https://github.com/c/9' });
    });
    const second = await h.sync.sync(minutes(T1, 1));
    expect(second.newEvents.map((e) => e.type)).toEqual(['issue_comment']);
    const third = await h.sync.sync(minutes(T1, 2));
    expect(third.newEvents).toHaveLength(0);
    expect(h.store.events.insertIfNew({ ...second.newEvents[0]!, historical: 0 }, T1)).toBeNull();
  });

  it('shares one in-flight sync between concurrent callers', async () => {
    const h = createHarness();
    h.github.put(makeSnapshot());
    await Promise.all([h.sync.sync(T0), h.sync.sync(T0), h.sync.sync(T0)]);
    expect(h.github.fetchCount).toBe(1);
  });
});

describe('event detection and severity', () => {
  async function afterBaseline() {
    const h = createHarness({ config: makeConfig({ alerts: { severity: { commit_pushed: 'off' }, importantCommentKeywords: ['blocker'] } }) });
    h.github.put(makeSnapshot());
    await h.sync.sync(T0);
    return h;
  }

  it('maps activity to configurable priorities', async () => {
    const h = await afterBaseline();
    h.github.update(PR, (s) => {
      s.title = 'Renamed';
      s.labels = ['bug'];
      s.headSha = 'ccc3';
      s.commits.push({ sha: 'ccc3', message: 'more', author: 'octo-author', date: T1.toISOString() });
      s.ci = { state: 'success', failing: [] };
      s.issueComments.push({ id: 20, user: 'reviewer-one', body: 'This is a blocker', createdAt: T1.toISOString(), url: 'https://github.com/c/20' });
      s.reviewComments.push({ id: 21, user: 'reviewer-two', body: 'nit', createdAt: T1.toISOString(), url: 'https://github.com/c/21', path: 'src/a.ts' });
      s.issueComments.push({ id: 22, user: 'octo-author', body: 'my own comment', createdAt: T1.toISOString(), url: 'https://github.com/c/22' });
    });
    const result = await h.sync.sync(T1);
    const byType = Object.fromEntries(result.newEvents.map((e) => [e.type, e]));
    expect(byType.title_changed!.severity).toBe('normal');
    expect(byType.labels_changed).toBeDefined();
    expect(byType.ci_passed!.severity).toBe('normal');
    expect(byType.reviewer_comment!.severity).toBe('high');
    expect(byType.reviewer_comment!.url).toBe('https://github.com/c/20');
    expect(byType.review_comment!.summary).toContain('src/a.ts');
    expect(byType.commit_pushed).toBeUndefined(); // severity "off": recorded but not alerted
    expect(h.store.events.list().some((e) => e.type === 'commit_pushed')).toBe(true);
    expect(result.newEvents.some((e) => e.summary.includes('my own comment'))).toBe(false);
  });

  it('detects merge and closure', async () => {
    const h = await afterBaseline();
    h.github.update(PR, (s) => Object.assign(s, { state: 'closed', merged: true, mergedAt: T1.toISOString() }));
    const merged = await h.sync.sync(T1);
    expect(merged.newEvents.map((e) => e.type)).toContain('pr_merged');
    expect(merged.newEvents.find((e) => e.type === 'pr_merged')!.severity).toBe('high');
  });

  it('detects closed without merge, deleted branch and reopen', async () => {
    const h = await afterBaseline();
    h.github.update(PR, (s) => Object.assign(s, { state: 'closed', closedAt: T1.toISOString(), headRepoMissing: true }));
    const closed = await h.sync.sync(T1);
    expect(closed.newEvents.map((e) => e.type).sort()).toEqual(['branch_deleted', 'pr_closed']);
    h.github.update(PR, (s) => Object.assign(s, { state: 'open', closedAt: null, updatedAt: minutes(T1, 5).toISOString() }));
    const reopened = await h.sync.sync(minutes(T1, 5));
    expect(reopened.newEvents.map((e) => e.type)).toContain('pr_reopened');
  });
});
