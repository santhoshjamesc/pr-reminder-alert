import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, ConfigStore } from '../src/service/config/configStore';
import { parseConfig } from '../src/service/config/schema';
import { emailFor, hasMapping } from '../src/service/core/reviewerReconciler';
import { isQuietTime, nextAllowedTime } from '../src/service/core/quietHours';
import { isListedPr } from '../src/service/service';
import { makeConfig } from './helpers/fixtures';
import { tempDbPath } from './helpers/harness';

describe('reviewer mapping', () => {
  it('maps GitHub usernames to configured email addresses case-insensitively', () => {
    const config = makeConfig();
    expect(emailFor('Reviewer-One', config)).toBe('reviewer1@example.com');
    expect(emailFor('@ACME/core', config)).toBe('core-team@example.com');
    expect(hasMapping('nobody', config)).toBe(false);
  });

  it('rejects invalid email addresses and logins', () => {
    expect(() => makeConfig({ reviewers: { 'reviewer-one': 'not-an-email' } })).toThrow();
    expect(() => makeConfig({ reviewers: { 'bad login!': 'a@example.com' } })).toThrow();
  });

  it('applies documented defaults', () => {
    const config = parseConfig({ github: { username: 'me' } });
    expect(config.reminders.intervalMinutes).toBe(30);
    expect(config.reminders.maxRemindersPerReviewer).toBe(5);
    expect(config.reminders.countCommentsAsResponse).toBe(false);
    expect(config.chat.sendInitialMessage).toBe(true);
    expect(config.alerts.alertOnHistorical).toBe(false);
  });

  it('validates time zones and repository names', () => {
    expect(() => makeConfig({ reminders: { timeZone: 'Mars/Olympus' } })).toThrow();
    expect(() => makeConfig({ github: { username: 'me', repositories: ['not a repo'] } })).toThrow();
  });

  it('persists configuration atomically with private permissions and loads the example config', () => {
    const file = path.join(path.dirname(tempDbPath()), 'config.json');
    const store = new ConfigStore(file);
    store.update(makeConfig());
    expect(new ConfigStore(file).load()?.github.username).toBe('octo-author');
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(() => store.update({ github: {} })).toThrow(ConfigError);
    const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'config.example.json'), 'utf8'));
    expect(() => parseConfig(example)).not.toThrow();
  });
});

describe('quiet hours', () => {
  const quiet = { enabled: true, start: '22:00', end: '08:00', quietDays: [] };

  it('handles windows that cross midnight in the configured time zone', () => {
    // 2026-10-01 is a Thursday. Tokyo is UTC+9.
    expect(isQuietTime(new Date('2026-10-01T13:30:00Z'), quiet, 'Asia/Tokyo')).toBe(true); // 22:30 JST
    expect(isQuietTime(new Date('2026-10-01T22:30:00Z'), quiet, 'Asia/Tokyo')).toBe(true); // 07:30 JST
    expect(isQuietTime(new Date('2026-10-01T23:00:00Z'), quiet, 'Asia/Tokyo')).toBe(false); // 08:00 JST
    expect(nextAllowedTime(new Date('2026-10-01T13:30:00Z'), quiet, 'Asia/Tokyo').toISOString()).toBe('2026-10-01T23:00:00.000Z');
  });

  it('handles same-day windows, quiet days and disabled settings', () => {
    const lunch = { enabled: true, start: '12:00', end: '13:00', quietDays: [0, 6] };
    expect(isQuietTime(new Date('2026-10-01T12:30:00Z'), lunch, 'UTC')).toBe(true);
    expect(isQuietTime(new Date('2026-10-01T13:00:00Z'), lunch, 'UTC')).toBe(false);
    // Saturday 2026-10-03 -> next allowed Monday 00:00 UTC
    expect(nextAllowedTime(new Date('2026-10-03T10:00:00Z'), lunch, 'UTC').toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(isQuietTime(new Date('2026-10-01T23:00:00Z'), { ...quiet, enabled: false }, 'UTC')).toBe(false);
  });

  it('handles daylight saving transitions', () => {
    // US DST ends 2026-11-01 at 02:00 local. 01:30 EDT = 05:30Z; quiet until 08:00 EST = 13:00Z.
    expect(nextAllowedTime(new Date('2026-11-01T05:30:00Z'), quiet, 'America/New_York').toISOString()).toBe('2026-11-01T13:00:00.000Z');
  });
});

describe('closed PR list retention', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

  it('keeps open PRs regardless of age', () => {
    expect(isListedPr({ state: 'open', merged_at: null, closed_at: null, updated_at: daysAgo(400) }, 7, now)).toBe(true);
  });

  it('hides merged and closed PRs once the retention period has passed', () => {
    expect(isListedPr({ state: 'merged', merged_at: daysAgo(6), closed_at: daysAgo(6), updated_at: daysAgo(6) }, 7, now)).toBe(true);
    expect(isListedPr({ state: 'merged', merged_at: daysAgo(8), closed_at: daysAgo(8), updated_at: daysAgo(1) }, 7, now)).toBe(false);
    expect(isListedPr({ state: 'closed', merged_at: null, closed_at: daysAgo(8), updated_at: daysAgo(8) }, 7, now)).toBe(false);
  });

  it('hides them straight away when set to 0 days', () => {
    expect(isListedPr({ state: 'merged', merged_at: daysAgo(0.01), closed_at: null, updated_at: daysAgo(0.01) }, 0, now)).toBe(false);
  });

  it('defaults to 7 days', () => {
    expect(parseConfig(makeConfig()).github.hideClosedPrsAfterDays).toBe(7);
  });
});
