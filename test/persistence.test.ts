import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/service/storage/store';
import { MIGRATIONS } from '../src/service/storage/migrations';
import { FakeGitHub, MockChatTransport, makeSnapshot } from './helpers/fixtures';
import { createHarness, minutes, tempDbPath } from './helpers/harness';

const T0 = new Date('2026-10-01T08:00:00.000Z');
const T1 = new Date('2026-10-01T09:01:00.000Z');

describe('persistence and recovery', () => {
  it('applies migrations once and records the schema version', () => {
    const file = tempDbPath();
    const a = new Store(file);
    expect(a.db.schemaVersion()).toBe(MIGRATIONS.at(-1)!.version);
    a.close();
    const b = new Store(file);
    expect(b.db.schemaVersion()).toBe(MIGRATIONS.at(-1)!.version);
    b.close();
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('does not resend initial DMs or reminders after a restart, and reuses cached DM spaces', async () => {
    const dbPath = tempDbPath();
    const github = new FakeGitHub();
    const transport = new MockChatTransport();
    let h = createHarness({ dbPath, github, transport });
    await h.cycle(T0);
    github.put(makeSnapshot());
    await h.cycle(T1);
    await h.cycle(minutes(T1, 30));
    expect(transport.sent).toHaveLength(4);
    h.store.close();

    // "Restart": new store/engines over the same database file.
    h = createHarness({ dbPath, github, transport });
    const lookups = transport.dmLookups;
    await h.cycle(minutes(T1, 31));
    expect(transport.sent).toHaveLength(4);
    const row = h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!;
    expect(row.reminder_count).toBe(1);
    expect(row.next_reminder_at).toBe(minutes(T1, 60).toISOString());
    // Baseline flag survives the restart, so nothing is treated as historical again.
    expect(h.store.events.list().some((e) => e.type === 'pr_opened' && e.historical === 0)).toBe(true);
    await h.cycle(minutes(T1, 60));
    expect(transport.sent).toHaveLength(6);
    expect(transport.dmLookups).toBe(lookups); // DM spaces come from the SQLite cache
    h.store.close();
  });

  it('marks messages interrupted mid-send as failed instead of re-sending them', async () => {
    const dbPath = tempDbPath();
    const github = new FakeGitHub();
    const h = createHarness({ dbPath, github });
    await h.cycle(T0);
    github.put(makeSnapshot({ requestedUsers: ['reviewer-one'] }));
    await h.sync.sync(T1);
    const queued = h.store.outbox.listDue(T1)[0]!;
    expect(h.store.outbox.claim(queued.id)).toBe(true); // crash right after claiming
    h.store.close();

    const restarted = new Store(dbPath);
    expect(restarted.outbox.recoverInterrupted()).toBe(1);
    expect(restarted.outbox.get(queued.id)!.status).toBe('failed');
    restarted.close();
  });

  it('is idempotent when the same reminder is queued twice', async () => {
    const h = createHarness();
    await h.cycle(T0);
    h.github.put(makeSnapshot({ requestedUsers: ['reviewer-one'] }));
    await h.cycle(T1);
    const pr = h.store.prs.get('acme/widgets#1')!;
    const reviewer = h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!;
    const { MessageComposer } = await import('../src/service/core/messageComposer');
    const composer = new MessageComposer(h.store);
    expect(composer.queueReminder(pr, reviewer, 1, h.config, T1)).toBe(true);
    expect(composer.queueReminder(pr, reviewer, 1, h.config, T1)).toBe(false);
  });
});
