import { describe, expect, it } from 'vitest';
import { renderInitialMessage } from '../src/service/chat/templates';
import { parseConfig } from '../src/service/config/schema';
import { maskPhone } from '../src/shared/redact';
import { WhatsAppError, classifyDelivery, findBrowser } from '../src/service/whatsapp/whatsappWeb';
import { ME, makeConfig, makeSnapshot } from './helpers/fixtures';
import { createHarness, minutes } from './helpers/harness';

const T0 = new Date('2026-10-01T08:00:00.000Z');
const T1 = new Date('2026-10-01T09:01:00.000Z');
const PR = { repo: 'acme/widgets', number: 1 };

/** reviewer-one: WhatsApp only; reviewer-two: email and WhatsApp. */
const waConfig = (enabled = true) =>
  makeConfig({
    reviewers: { 'reviewer-two': 'reviewer2@example.com' },
    whatsapp: { enabled, numbers: { 'reviewer-one': '+91 98765 43210', 'Reviewer-Two': '+44 7700 900123' } },
  });

async function openPr(config = waConfig()) {
  const h = createHarness({ config });
  await h.cycle(T0);
  h.github.put(makeSnapshot());
  await h.cycle(T1);
  return h;
}

describe('WhatsApp configuration', () => {
  it('normalises phone numbers to digits with country code', () => {
    const config = parseConfig({ github: { username: ME }, whatsapp: { numbers: { a: '+91 (98765) 43210', b: '0044-7700-900123' } } });
    expect(config.whatsapp.numbers).toEqual({ a: '919876543210', b: '447700900123' });
  });

  it('rejects numbers without a country code or with letters', () => {
    expect(() => parseConfig({ github: { username: ME }, whatsapp: { numbers: { a: '12345' } } })).toThrow();
    expect(() => parseConfig({ github: { username: ME }, whatsapp: { numbers: { a: '+91 98765 abcde' } } })).toThrow();
  });

  it('is off by default', () => {
    expect(parseConfig({ github: { username: ME } }).whatsapp).toEqual({ enabled: false, chromePath: '', numbers: {} });
  });

  it('masks phone numbers', () => {
    expect(maskPhone('919876543210')).toBe('+91******3210');
  });
});

describe('WhatsApp messages', () => {
  it('sends the initial message and reminders to mapped WhatsApp numbers', async () => {
    const h = await openPr();
    expect(h.whatsapp.sent.map((m) => m.to).sort()).toEqual(['447700900123', '919876543210']);
    // reviewer-two also has an email, so they get the Google Chat DM as well; reviewer-one does not.
    expect(h.transport.sent.map((m) => m.to)).toEqual(['reviewer2@example.com']);
    expect(h.whatsapp.sent[0]?.text).toContain('Your review is requested');

    h.whatsapp.sent = [];
    await h.cycle(minutes(T1, 30));
    expect(h.whatsapp.sent).toHaveLength(2);
    expect(h.whatsapp.sent[0]?.text).toContain('reminder 1 of 5');
  });

  it('uses a plain URL (WhatsApp has no Chat-style link syntax)', () => {
    const ctx = { repo: 'acme/widgets', number: 1, title: 'T', url: 'https://github.com/acme/widgets/pull/1', author: ME, createdAt: T0.toISOString(), reviewers: [], reviewerLogin: 'r' };
    expect(renderInitialMessage({ ...ctx, channel: 'whatsapp' })).toContain('acme/widgets#1: T\nhttps://github.com/acme/widgets/pull/1');
    expect(renderInitialMessage(ctx)).toContain('<https://github.com/acme/widgets/pull/1|');
  });

  it('ignores numbers while WhatsApp is disabled (reviewer counts as unmapped)', async () => {
    const h = await openPr(waConfig(false));
    expect(h.whatsapp.sent).toHaveLength(0);
    expect(h.store.reviewers.get('acme/widgets#1', 'reviewer-one')!.next_reminder_at).toBeNull();
    expect(h.transport.sent.map((m) => m.to)).toEqual(['reviewer2@example.com']);
  });

  it('stops WhatsApp reminders once the reviewer submits a review', async () => {
    const h = await openPr();
    h.github.update(PR, (s) => {
      s.requestedUsers = ['reviewer-two'];
      s.reviews = [{ id: 1, user: 'reviewer-one', state: 'APPROVED', body: '', submittedAt: minutes(T1, 5).toISOString(), url: '', commitId: null }];
    });
    h.whatsapp.sent = [];
    await h.cycle(minutes(T1, 30));
    expect(h.whatsapp.sent.map((m) => m.to)).toEqual(['447700900123']);
  });

  it('keeps messages queued while WhatsApp is not linked, then sends them without using up attempts', async () => {
    const h = createHarness({ config: waConfig() });
    h.whatsapp.linked = false;
    await h.cycle(T0);
    h.github.put(makeSnapshot());
    await h.cycle(T1);
    expect(h.whatsapp.sent).toHaveLength(0);
    const queued = h.store.outbox.list('queued').filter((r) => r.channel === 'whatsapp');
    expect(queued).toHaveLength(2);
    expect(queued.every((r) => r.attempts === 0)).toBe(true);

    h.whatsapp.linked = true;
    await h.cycle(minutes(T1, 1));
    expect(h.whatsapp.sent).toHaveLength(2);
  });

  it('re-queues without counting an attempt when WhatsApp turns out to be logged out mid-send', async () => {
    const h = createHarness({ config: waConfig() });
    h.whatsapp.failures = [new WhatsAppError('logged out', false, true), new WhatsAppError('logged out', false, true)];
    await h.cycle(T0);
    h.github.put(makeSnapshot());
    await h.cycle(T1);
    const rows = h.store.outbox.list().filter((r) => r.channel === 'whatsapp');
    expect(rows.every((r) => r.status === 'queued' && r.attempts === 0)).toBe(true);
    await h.cycle(minutes(T1, 6));
    expect(h.whatsapp.sent).toHaveLength(2);
  });

  it('fails permanently for an invalid WhatsApp number', async () => {
    const h = createHarness({ config: waConfig() });
    h.whatsapp.failures = [new WhatsAppError('+919876543210 is not a valid WhatsApp number', false)];
    await h.cycle(T0);
    h.github.put(makeSnapshot());
    await h.cycle(T1);
    const failed = h.store.outbox.list('failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.channel).toBe('whatsapp');
  });

  it('retries transient WhatsApp failures with backoff', async () => {
    const h = createHarness({ config: waConfig() });
    h.whatsapp.failures = [new WhatsAppError('timeout', true)];
    await h.cycle(T0);
    h.github.put(makeSnapshot());
    await h.cycle(T1);
    expect(h.whatsapp.sent).toHaveLength(1);
    await h.cycle(minutes(T1, 2));
    expect(h.whatsapp.sent).toHaveLength(2);
  });

  it('does not send duplicate WhatsApp messages across restarts (idempotency keys)', async () => {
    const h = await openPr();
    await h.cycle(minutes(T1, 1));
    await h.cycle(minutes(T1, 2));
    expect(h.whatsapp.sent).toHaveLength(2);
  });
});

describe('WhatsApp delivery check', () => {
  const base = { composeFound: true, composeText: 0, outgoingBefore: 3, outgoingNow: 3, lastSent: true, lastPending: false, anyPending: false };

  it('is sent once the new outgoing bubble has a tick', () => {
    expect(classifyDelivery({ ...base, outgoingNow: 4 })).toBe('sent');
  });

  it('ignores a pending clock on an older message', () => {
    expect(classifyDelivery({ ...base, outgoingNow: 4, anyPending: true })).toBe('sent');
  });

  it('counts a new bubble that still shows the clock as queued', () => {
    expect(classifyDelivery({ ...base, outgoingNow: 4, lastSent: false, lastPending: true })).toBe('queued');
  });

  it('is not sent while the text is still in the box', () => {
    expect(classifyDelivery({ ...base, composeText: 12 })).toBe('notSent');
  });

  it('falls back to "box emptied, nothing pending" when bubbles cannot be found', () => {
    expect(classifyDelivery({ ...base, outgoingBefore: 0, outgoingNow: 0, lastSent: false })).toBe('sent');
    expect(classifyDelivery({ ...base, outgoingBefore: 0, outgoingNow: 0, lastSent: false, anyPending: true })).toBe('unknown');
  });

  it('is unknown when nothing changed and the box is empty', () => {
    expect(classifyDelivery(base)).toBe('unknown');
  });
});

describe('browser detection', () => {
  it('uses the configured path only if it exists', () => {
    expect(findBrowser('/opt/chrome', (p) => p === '/opt/chrome')).toBe('/opt/chrome');
    expect(findBrowser('/opt/missing', () => false)).toBeNull();
  });

  it('auto-detects a known install location', () => {
    expect(findBrowser('', (p) => /chrom|edge|brave/i.test(p))).not.toBeNull();
    expect(findBrowser('', () => false)).toBeNull();
  });
});
