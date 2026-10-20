import { describe, expect, it } from 'vitest';
import { AlertState, type AlertSettings } from '../src/extension/alerts/alertPolicy';
import { buildServiceConfig, isAllowedPrUrl, parseReviewerPairs } from '../src/extension/configBuilder';
import { parseConfig } from '../src/service/config/schema';
import type { EventDto } from '../src/shared/protocol';

const settings: AlertSettings = {
  highStyles: ['notification', 'banner', 'sound', 'statusBar'],
  normalStyles: ['notification', 'statusBar'],
  soundEnabled: true,
  quietMode: false,
  repeatTypes: ['changes_requested'],
  repeatIntervalMs: 60_000,
};

let seq = 1;
function event(partial: Partial<EventDto> = {}): EventDto {
  const id = partial.id ?? seq++;
  return {
    id,
    key: `k${id}`,
    prKey: 'acme/widgets#1',
    repo: 'acme/widgets',
    number: 1,
    prTitle: 'T',
    type: 'changes_requested',
    severity: 'high',
    summary: 's',
    url: 'https://github.com/acme/widgets/pull/1',
    actor: null,
    occurredAt: '',
    recordedAt: '',
    historical: false,
    acknowledged: false,
    ...partial,
  };
}

describe('alert acknowledgement and snoozing', () => {
  it('presents new events once with severity-specific styles', () => {
    const state = new AlertState(settings);
    const high = event();
    const normal = event({ type: 'issue_comment', severity: 'normal' });
    const decisions = state.ingest([high, normal], 0);
    expect(decisions.map((d) => d.styles)).toEqual([settings.highStyles, settings.normalStyles]);
    expect(state.ingest([high, normal], 1)).toHaveLength(0);
    expect(state.unacknowledgedCount()).toBe(2);
    expect(state.hasHighPriority()).toBe(true);
  });

  it('ignores historical, already acknowledged and disabled events', () => {
    const state = new AlertState(settings);
    expect(state.ingest([event({ historical: true }), event({ acknowledged: true }), event({ severity: 'off' })], 0)).toHaveLength(0);
  });

  it('repeats selected critical events until acknowledged', () => {
    const state = new AlertState(settings);
    const critical = event();
    state.ingest([critical, event({ type: 'ci_passed', severity: 'normal' })], 0);
    expect(state.dueRepeats(30_000)).toHaveLength(0);
    const due = state.dueRepeats(60_000);
    expect(due.map((d) => d.event.id)).toEqual([critical.id]);
    expect(due[0]!.styles).not.toContain('statusBar');
    expect(state.dueRepeats(90_000)).toHaveLength(0);
    expect(state.acknowledge([critical.id])).toEqual([critical.id]);
    expect(state.dueRepeats(500_000)).toHaveLength(0);
  });

  it('snoozing suppresses pop-ups, banners, sounds and repeats but keeps the status bar', () => {
    const state = new AlertState(settings);
    state.snooze(10 * 60_000, 0);
    expect(state.isSnoozed(1000)).toBe(true);
    const [decision] = state.ingest([event()], 1000);
    expect(decision!.styles).toEqual(['statusBar']);
    expect(state.dueRepeats(5 * 60_000)).toHaveLength(0);
    // After the snooze expires, unacknowledged critical events repeat again.
    expect(state.isSnoozed(10 * 60_000)).toBe(false);
    expect(state.dueRepeats(11 * 60_000)).toHaveLength(1);
  });

  it('quiet mode and disabled sound reduce alert styles', () => {
    const quiet = new AlertState({ ...settings, quietMode: true });
    expect(quiet.ingest([event()], 0)[0]!.styles).toEqual(['statusBar']);
    const silent = new AlertState({ ...settings, soundEnabled: false });
    expect(silent.ingest([event()], 0)[0]!.styles).not.toContain('sound');
  });

  it('acknowledge all clears every open alert', () => {
    const state = new AlertState(settings);
    state.ingest([event(), event()], 0);
    expect(state.acknowledge('all')).toHaveLength(2);
    expect(state.unacknowledgedCount()).toBe(0);
  });
});

describe('extension configuration helpers', () => {
  it('builds a valid service configuration from VS Code settings', () => {
    const values: Record<string, unknown> = {
      'github.username': 'octo-author',
      'github.repositories': ['acme/widgets', ' '],
      reviewers: { 'reviewer-one': 'reviewer1@example.com' },
      'reminders.quietHours.enabled': true,
    };
    const get = <T,>(key: string, fallback: T) => (key in values ? (values[key] as T) : fallback);
    const config = parseConfig(buildServiceConfig(get, 'Europe/Berlin'));
    expect(config.github.repositories).toEqual(['acme/widgets']);
    expect(config.reminders.timeZone).toBe('Europe/Berlin');
    expect(config.reminders.quietHours.enabled).toBe(true);
    expect(config.reminders.intervalMinutes).toBe(30);
  });

  it('parses reviewer mapping input from the setup wizard', () => {
    const { mapping, errors } = parseReviewerPairs('reviewer-one=reviewer1@example.com, @acme/core: core@example.com; bad entry');
    expect(mapping).toEqual({ 'reviewer-one': 'reviewer1@example.com', '@acme/core': 'core@example.com' });
    expect(errors).toEqual(['bad entry']);
  });

  it('only opens https links on the GitHub host', () => {
    expect(isAllowedPrUrl('https://github.com/a/b/pull/1', 'https://api.github.com')).toBe(true);
    expect(isAllowedPrUrl('javascript:alert(1)', 'https://api.github.com')).toBe(false);
    expect(isAllowedPrUrl('https://evil.example/a', 'https://api.github.com')).toBe(false);
    expect(isAllowedPrUrl('https://ghe.corp/a/b/pull/1', 'https://ghe.corp/api/v3')).toBe(true);
  });
});
