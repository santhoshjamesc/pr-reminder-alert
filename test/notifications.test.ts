import { describe, expect, it } from 'vitest';
import { makeConfig, makeSnapshot } from './helpers/fixtures';
import { createHarness, minutes } from './helpers/harness';

const T0 = new Date('2026-10-01T08:00:00.000Z'); // baseline sync, before the PR exists
const T1 = new Date('2026-10-01T09:01:00.000Z'); // PR (created 09:00) first seen

async function withBaseline() {
  const h = createHarness();
  await h.cycle(T0); // empty baseline
  return h;
}

describe('new PR notifications', () => {
  it('DMs every mapped requested reviewer once in Google Chat when a PR is opened', async () => {
    const h = await withBaseline();
    h.github.put(makeSnapshot());
    await h.cycle(T1);

    expect(h.transport.sent.map((m) => m.to).sort()).toEqual(['reviewer1@example.com', 'reviewer2@example.com']);
    const dm = h.transport.sent[0]!;
    expect(dm.text.startsWith('[acme/widgets#1]')).toBe(true);
    expect(dm.text).toContain('Your review is requested');
    expect(dm.text).toContain('<https://github.com/acme/widgets/pull/1|acme/widgets#1: Add sprocket support>');
    expect(dm.text).toContain('@octo-author');
    expect(dm.text).toContain('@reviewer-one, @reviewer-two');
    expect(dm.text).toContain('Files changed');
    // Each reviewer gets their own private DM space.
    expect(new Set(h.transport.sent.map((m) => m.space)).size).toBe(2);

    // A second sync of the same state sends nothing new.
    await h.cycle(minutes(T1, 1));
    expect(h.transport.sent).toHaveLength(2);
  });

  it('never messages unmapped reviewers and reports them as unmapped', async () => {
    const h = await withBaseline();
    h.github.put(makeSnapshot({ requestedUsers: ['reviewer-one', 'stranger'] }));
    await h.cycle(T1);

    expect(h.transport.sent.map((m) => m.to)).toEqual(['reviewer1@example.com']);
    const stranger = h.store.reviewers.get('acme/widgets#1', 'stranger')!;
    expect(stranger.status).toBe('pending');
    expect(stranger.next_reminder_at).toBeNull();
  });

  it('ignores addresses that appear in PR descriptions or comments', async () => {
    const h = await withBaseline();
    h.github.put(
      makeSnapshot({
        requestedUsers: ['stranger'],
        body: 'Please cc attacker@evil.example',
        issueComments: [{ id: 1, user: 'stranger', body: 'mail me at x@evil.example', createdAt: T1.toISOString(), url: 'https://github.com/c/1' }],
      }),
    );
    await h.cycle(T1);
    expect(h.transport.sent).toHaveLength(0);
  });

  it('neutralises Chat formatting, links and mentions in untrusted PR titles', async () => {
    const h = await withBaseline();
    h.github.put(makeSnapshot({ title: '<users/all> <https://evil.example|click> *bold* `x`\nline', requestedUsers: ['reviewer-one'] }));
    await h.cycle(T1);
    const text = h.transport.sent[0]!.text;
    expect(text).not.toContain('<users/all>');
    expect(text).not.toContain('<https://evil.example');
    expect(text).not.toContain('*bold*');
    expect(text).toContain('‹users/all›');
    // The only link is the PR link.
    expect(text.match(/<https:/g)).toHaveLength(1);
  });

  it('does not send initial DMs when disabled', async () => {
    const h = createHarness({ config: makeConfig({ chat: { sendInitialMessage: false } }) });
    await h.cycle(T0);
    h.github.put(makeSnapshot());
    await h.cycle(T1);
    expect(h.transport.sent).toHaveLength(0);
  });

  it('does not message reviewers of draft PRs', async () => {
    const h = await withBaseline();
    h.github.put(makeSnapshot({ draft: true }));
    await h.cycle(T1);
    await h.cycle(minutes(T1, 31));
    expect(h.transport.sent).toHaveLength(0);
  });

  it('messages team reviewers through a team mapping', async () => {
    const h = await withBaseline();
    h.github.put(makeSnapshot({ requestedUsers: [], requestedTeams: ['@acme/core'] }));
    await h.cycle(T1);
    expect(h.transport.sent.map((m) => m.to)).toEqual(['core-team@example.com']);
  });
});

describe('reviewer reassignment', () => {
  it('notifies newly requested reviewers and stops reminders for removed ones', async () => {
    const h = await withBaseline();
    h.github.put(makeSnapshot({ requestedUsers: ['reviewer-one'] }));
    await h.cycle(T1);
    expect(h.transport.sent.map((m) => m.to)).toEqual(['reviewer1@example.com']);

    // reviewer-one is replaced by reviewer-two.
    h.github.update({ repo: 'acme/widgets', number: 1 }, (s) => {
      s.requestedUsers = ['reviewer-two'];
    });
    await h.cycle(minutes(T1, 5));
    expect(h.transport.sent.map((m) => m.to)).toEqual(['reviewer1@example.com', 'reviewer2@example.com']);
    expect(h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!.status).toBe('removed');

    // Only reviewer-two keeps getting reminders.
    await h.cycle(minutes(T1, 40));
    const reminders = h.transport.sent.slice(2);
    expect(reminders.map((m) => m.to)).toEqual(['reviewer2@example.com']);
    expect(reminders[0]!.text).toContain('Reminder: your review is still pending');

    const events = h.store.events.list().map((e) => e.type);
    expect(events).toContain('review_request_removed');
    expect(events.filter((t) => t === 'review_requested')).toHaveLength(2);
  });

  it('starts a fresh reminder cycle when a reviewer is re-requested after reviewing', async () => {
    const h = await withBaseline();
    h.github.put(makeSnapshot({ requestedUsers: ['reviewer-one'] }));
    await h.cycle(T1);
    h.github.update({ repo: 'acme/widgets', number: 1 }, (s) => {
      s.requestedUsers = [];
      s.reviews = [{ id: 1, user: 'reviewer-one', state: 'COMMENTED', body: 'looks ok', submittedAt: minutes(T1, 2).toISOString(), url: '', commitId: null }];
    });
    await h.cycle(minutes(T1, 3));
    expect(h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!.status).toBe('responded');

    h.github.update({ repo: 'acme/widgets', number: 1 }, (s) => {
      s.requestedUsers = ['reviewer-one'];
    });
    await h.cycle(minutes(T1, 10));
    const row = h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!;
    expect(row.status).toBe('pending');
    expect(row.cycle).toBe(2);
    expect(row.reminder_count).toBe(0);
    expect(h.transport.sent).toHaveLength(2);
    expect(h.transport.sent[1]!.text).toContain('requested again');
  });
});
