import { describe, expect, it } from 'vitest';
import { makeConfig, makeSnapshot } from './helpers/fixtures';
import { createHarness, minutes } from './helpers/harness';
import { KV_KEYS } from '../src/service/storage/store';

const T0 = new Date('2026-10-01T08:00:00.000Z');
const T1 = new Date('2026-10-01T09:01:00.000Z');
const PR = { repo: 'acme/widgets', number: 1 };

async function openPr(config = makeConfig(), snapshot = makeSnapshot()) {
  const h = createHarness({ config });
  await h.cycle(T0);
  h.github.put(snapshot);
  await h.cycle(T1);
  h.transport.sent = []; // drop initial emails
  return h;
}

const remindersTo = (h: Awaited<ReturnType<typeof openPr>>, to: string) => h.transport.sent.filter((m) => m.to === to).length;

describe('reminder scheduling', () => {
  it('sends a reminder every configured interval (default 30 minutes)', async () => {
    const h = await openPr();
    await h.cycle(minutes(T1, 29));
    expect(h.transport.sent).toHaveLength(0);
    await h.cycle(minutes(T1, 30));
    expect(h.transport.sent).toHaveLength(2);
    expect(h.transport.sent[0]!.text).toContain('reminder 1 of 5');
    expect(h.transport.sent[0]!.text).toMatch(/Opened 31 minutes ago/);
    await h.cycle(minutes(T1, 45));
    expect(h.transport.sent).toHaveLength(2);
    await h.cycle(minutes(T1, 60));
    expect(h.transport.sent).toHaveLength(4);
    const row = h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!;
    expect(row.reminder_count).toBe(2);
    expect(row.next_reminder_at).toBe(minutes(T1, 90).toISOString());
  });

  it('respects a custom interval', async () => {
    const h = await openPr(makeConfig({ reminders: { intervalMinutes: 10 } }));
    await h.cycle(minutes(T1, 10));
    await h.cycle(minutes(T1, 20));
    expect(remindersTo(h, 'reviewer1@example.com')).toBe(2);
  });

  it('stops after the maximum reminder count per reviewer', async () => {
    const h = await openPr(makeConfig({ reminders: { maxRemindersPerReviewer: 3 } }));
    for (let i = 1; i <= 8; i++) {
      await h.cycle(minutes(T1, 30 * i));
    }
    expect(remindersTo(h, 'reviewer1@example.com')).toBe(3);
    expect(remindersTo(h, 'reviewer2@example.com')).toBe(3);
    expect(h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!.next_reminder_at).toBeNull();
    expect(h.transport.sent.at(-1)!.text).toContain('reminder 3 of 3');
  });

  it('defaults to 5 reminders', async () => {
    const h = await openPr();
    for (let i = 1; i <= 10; i++) {
      await h.cycle(minutes(T1, 30 * i));
    }
    expect(remindersTo(h, 'reviewer1@example.com')).toBe(5);
  });
});

describe('quiet hours', () => {
  it('defers reminders until the next allowed window in the configured time zone', async () => {
    // 22:00-08:00 in New York (UTC-4 in October). 09:31Z = 05:31 local, which is quiet.
    const config = makeConfig({
      reminders: { timeZone: 'America/New_York', quietHours: { enabled: true, start: '22:00', end: '08:00' } },
    });
    const h = await openPr(config);
    // Initial emails were also deferred (05:01 local) - they are still queued.
    expect(h.store.outbox.count('queued')).toBe(2);
    await h.cycle(minutes(T1, 30));
    expect(h.transport.sent).toHaveLength(0);
    const row = h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!;
    expect(row.next_reminder_at).toBe('2026-10-01T12:00:00.000Z'); // 08:00 New York
    expect(row.reminder_count).toBe(0);

    await h.cycle(new Date('2026-10-01T12:00:00.000Z'));
    // Two deferred initial emails + two reminders.
    expect(h.transport.sent).toHaveLength(4);
  });
});

describe('stopping reminders', () => {
  it('stops reminders for a reviewer once they submit a review, while others continue', async () => {
    const h = await openPr();
    h.github.update(PR, (s) => {
      s.requestedUsers = ['reviewer-two'];
      s.reviews = [{ id: 1, user: 'reviewer-one', state: 'APPROVED', body: '', submittedAt: minutes(T1, 10).toISOString(), url: '', commitId: null }];
    });
    for (let i = 1; i <= 3; i++) {
      await h.cycle(minutes(T1, 30 * i));
    }
    expect(remindersTo(h, 'reviewer1@example.com')).toBe(0);
    expect(remindersTo(h, 'reviewer2@example.com')).toBe(3);
    const one = h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!;
    expect(one.status).toBe('responded');
    expect(one.review_state).toBe('APPROVED');
  });

  it.each(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'])('treats %s as a response', async (state) => {
    const h = await openPr(makeConfig({ reminders: { remindAfterChangesRequested: false } }));
    h.github.update(PR, (s) => {
      s.requestedUsers = ['reviewer-two'];
      s.reviews = [{ id: 1, user: 'reviewer-one', state, body: 'x', submittedAt: minutes(T1, 1).toISOString(), url: '', commitId: null }];
    });
    await h.cycle(minutes(T1, 30));
    expect(remindersTo(h, 'reviewer1@example.com')).toBe(0);
  });

  it('does not treat one approval as proof that other reviewers responded', async () => {
    const h = await openPr();
    h.github.update(PR, (s) => {
      // GitHub still lists reviewer-two as requested.
      s.requestedUsers = ['reviewer-two'];
      s.reviews = [{ id: 1, user: 'reviewer-one', state: 'APPROVED', body: '', submittedAt: minutes(T1, 1).toISOString(), url: '', commitId: null }];
    });
    await h.cycle(minutes(T1, 30));
    expect(h.store.reviewers.get('acme/widgets#1', 'reviewer-two')!.status).toBe('pending');
    expect(remindersTo(h, 'reviewer2@example.com')).toBe(1);
  });

  it('does not count plain or inline comments as a review by default', async () => {
    const h = await openPr();
    h.github.update(PR, (s) => {
      s.issueComments = [{ id: 11, user: 'reviewer-one', body: 'Will look later', createdAt: minutes(T1, 5).toISOString(), url: 'https://github.com/c/11' }];
      // An inline "single comment" creates an empty COMMENTED review and GitHub drops the request.
      s.requestedUsers = ['reviewer-two'];
      s.reviews = [{ id: 7, user: 'reviewer-one', state: 'COMMENTED', body: '', submittedAt: minutes(T1, 6).toISOString(), url: '', commitId: null }];
      s.reviewComments = [{ id: 12, user: 'reviewer-one', body: 'nit', createdAt: minutes(T1, 6).toISOString(), url: 'https://github.com/c/12', path: 'a.ts', reviewId: 7 }];
    });
    await h.cycle(minutes(T1, 30));
    expect(h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!.status).toBe('pending');
    expect(remindersTo(h, 'reviewer1@example.com')).toBe(1);
  });

  it('counts comments as a response when explicitly enabled', async () => {
    const h = await openPr(makeConfig({ reminders: { countCommentsAsResponse: true } }));
    h.github.update(PR, (s) => {
      s.issueComments = [{ id: 11, user: 'reviewer-one', body: 'Looking now', createdAt: minutes(T1, 5).toISOString(), url: 'https://github.com/c/11' }];
    });
    await h.cycle(minutes(T1, 30));
    expect(h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!.status).toBe('responded');
    expect(remindersTo(h, 'reviewer1@example.com')).toBe(0);
  });

  it('reminds a reviewer who requested changes again after new commits (configurable)', async () => {
    const h = await openPr();
    h.github.update(PR, (s) => {
      s.requestedUsers = ['reviewer-two'];
      s.reviews = [{ id: 1, user: 'reviewer-one', state: 'CHANGES_REQUESTED', body: 'fix', submittedAt: minutes(T1, 5).toISOString(), url: '', commitId: 'aaaaaaa1' }];
    });
    await h.cycle(minutes(T1, 6));
    expect(h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!.status).toBe('responded');

    h.github.update(PR, (s) => {
      s.headSha = 'bbbbbbb2';
      s.commits.push({ sha: 'bbbbbbb2', message: 'Address review', author: 'octo-author', date: minutes(T1, 20).toISOString() });
    });
    await h.cycle(minutes(T1, 21));
    const row = h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!;
    expect(row.status).toBe('pending');
    expect(row.cycle).toBe(2);
    await h.cycle(minutes(T1, 21 + 30));
    await h.cycle(minutes(T1, 21 + 31)); // stays pending without a GitHub request
    expect(h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!.status).toBe('pending');
    expect(remindersTo(h, 'reviewer1@example.com')).toBe(2); // re-review email + 1 reminder
  });

  it('does not re-remind after changes requested when disabled', async () => {
    const h = await openPr(makeConfig({ reminders: { remindAfterChangesRequested: false } }));
    h.github.update(PR, (s) => {
      s.requestedUsers = ['reviewer-two'];
      s.reviews = [{ id: 1, user: 'reviewer-one', state: 'CHANGES_REQUESTED', body: 'fix', submittedAt: minutes(T1, 5).toISOString(), url: '', commitId: 'aaaaaaa1' }];
    });
    await h.cycle(minutes(T1, 6));
    h.github.update(PR, (s) => {
      s.commits.push({ sha: 'bbbbbbb2', message: 'Fix', author: 'octo-author', date: minutes(T1, 20).toISOString() });
    });
    await h.cycle(minutes(T1, 60));
    expect(remindersTo(h, 'reviewer1@example.com')).toBe(0);
  });

  it.each([
    ['merged', { state: 'closed' as const, merged: true, mergedAt: '2026-10-01T09:10:00.000Z' }],
    ['closed', { state: 'closed' as const, merged: false, closedAt: '2026-10-01T09:10:00.000Z' }],
  ])('stops all reminders when the PR is %s', async (_label, change) => {
    const h = await openPr();
    h.github.update(PR, (s) => Object.assign(s, change));
    for (let i = 1; i <= 3; i++) {
      await h.cycle(minutes(T1, 30 * i));
    }
    expect(h.transport.sent).toHaveLength(0);
    expect(h.store.reviewers.listForPr('acme/widgets#1').every((r) => r.next_reminder_at === null)).toBe(true);
  });

  it('cancels queued emails if the PR closes before they are delivered', async () => {
    const h = createHarness();
    await h.cycle(T0);
    h.github.put(makeSnapshot());
    await h.sync.sync(T1); // queues initial emails but does not deliver
    h.github.update(PR, (s) => Object.assign(s, { state: 'closed', closedAt: T1.toISOString() }));
    await h.cycle(minutes(T1, 1));
    expect(h.transport.sent).toHaveLength(0);
    expect(h.store.outbox.count('cancelled')).toBe(2);
  });

  it('stops reminders when the PR becomes inaccessible (deleted or permission lost)', async () => {
    const h = await openPr();
    h.github.inaccessible.set('acme/widgets#1', 404);
    for (let i = 1; i <= 4; i++) {
      await h.cycle(minutes(T1, 30 * i));
    }
    expect(h.store.prs.get('acme/widgets#1')!.state).toBe('inaccessible');
    expect(h.transport.sent).toHaveLength(0);
    expect(h.store.events.list().some((e) => e.type === 'pr_inaccessible')).toBe(true);
  });
});

describe('pause and resume', () => {
  it('pauses and resumes reminders for one PR', async () => {
    const h = await openPr();
    h.store.prs.setPaused('acme/widgets#1', true);
    await h.cycle(minutes(T1, 30));
    expect(h.transport.sent).toHaveLength(0);
    h.store.prs.setPaused('acme/widgets#1', false);
    await h.cycle(minutes(T1, 31));
    expect(h.transport.sent).toHaveLength(2);
  });

  it('pauses globally', async () => {
    const h = await openPr();
    h.store.kv.set(KV_KEYS.globalPaused, 'true');
    await h.sync.sync(minutes(T1, 30));
    expect((await h.reminders.tick(minutes(T1, 30))).skipped).toBe('paused');
    expect(h.transport.sent).toHaveLength(0);
    h.store.kv.set(KV_KEYS.globalPaused, 'false');
    await h.reminders.tick(minutes(T1, 31));
    expect(h.transport.sent).toHaveLength(2);
  });
});

describe('scheduler safety', () => {
  it('does not send reminders based on stale data when GitHub is unreachable', async () => {
    const h = await openPr();
    h.github.discoverError = new Error('network down');
    const result = await (async () => {
      await h.sync.sync(minutes(T1, 60));
      return h.reminders.tick(minutes(T1, 60));
    })();
    expect(result.stale).toBe(2);
    expect(h.transport.sent).toHaveLength(0);
  });

  it('prevents concurrent scheduler runs from sending duplicates', async () => {
    const h = await openPr();
    const at = minutes(T1, 30);
    await h.sync.sync(at);
    await Promise.all([h.reminders.tick(at), h.reminders.tick(at), h.reminders.tick(at)]);
    expect(h.transport.sent).toHaveLength(2);
  });

  it('honours a lease held by another process', async () => {
    const h = await openPr();
    h.store.kv.tryAcquireLease('scheduler', 'other-process', 60_000, minutes(T1, 30));
    expect((await h.reminders.tick(minutes(T1, 30))).skipped).toBe('locked');
    expect(h.transport.sent).toHaveLength(0);
  });

  it('records reviewers who already reviewed (request dropped by GitHub) as responded, without messaging them', async () => {
    const reviews = [{ id: 1, user: 'reviewer-one', state: 'COMMENTED', body: 'looks ok', submittedAt: minutes(T0, -10).toISOString(), url: '', commitId: null }];
    const h = await openPr(makeConfig(), makeSnapshot({ requestedUsers: [], reviews }));
    const one = h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!;
    expect(one.status).toBe('responded');
    expect(one.review_state).toBe('COMMENTED');
    await h.cycle(minutes(T1, 60));
    expect(h.transport.sent).toHaveLength(0);

    // Re-requesting the review starts a new reminder cycle.
    h.github.update(PR, (s) => {
      s.requestedUsers = ['reviewer-one'];
    });
    await h.cycle(minutes(T1, 61));
    expect(h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!.status).toBe('pending');
  });

  it('reschedules a reviewer once an email mapping is added', async () => {
    const h = await openPr(makeConfig({ reviewers: {} }));
    expect(h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!.next_reminder_at).toBeNull();
    h.setConfig(makeConfig());
    await h.cycle(minutes(T1, 5));
    expect(h.transport.sent.map((m) => m.to).sort()).toEqual(['reviewer1@example.com', 'reviewer2@example.com']);
    await h.cycle(minutes(T1, 35));
    expect(h.transport.sent).toHaveLength(4);
  });
});
