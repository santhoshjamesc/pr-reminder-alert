/**
 * Converts VS Code settings into the notification service configuration.
 * Kept free of the `vscode` module so it can be unit tested.
 */
import type { AppConfigInput } from '../service/config/schema';

export type SettingsReader = <T>(key: string, fallback: T) => T;

export function buildServiceConfig(get: SettingsReader, defaultTimeZone: string): AppConfigInput {
  const timeZone = get<string>('reminders.timeZone', '').trim() || defaultTimeZone;
  return {
    github: {
      username: get<string>('github.username', '').trim(),
      repositories: get<string[]>('github.repositories', []).map((r) => r.trim()).filter(Boolean),
      includeDrafts: get<boolean>('github.includeDrafts', true),
      pollIntervalSeconds: get<number>('github.pollIntervalSeconds', 120),
      apiBaseUrl: get<string>('github.apiBaseUrl', 'https://api.github.com'),
      hideClosedPrsAfterDays: get<number>('github.hideClosedPrsAfterDays', 7),
    },
    reviewers: get<Record<string, string>>('reviewers', {}),
    chat: {
      enabled: get<boolean>('chat.enabled', true),
      sendInitialMessage: get<boolean>('chat.sendInitialMessage', true),
      sendInitialMessageForExistingPrs: get<boolean>('chat.sendInitialMessageForExistingPrs', false),
      maxAttempts: get<number>('chat.maxAttempts', 5),
    },
    whatsapp: {
      enabled: get<boolean>('whatsapp.enabled', false),
      chromePath: get<string>('whatsapp.chromePath', '').trim(),
      numbers: get<Record<string, string>>('whatsapp.numbers', {}),
    },
    reminders: {
      intervalMinutes: get<number>('reminders.intervalMinutes', 30),
      maxRemindersPerReviewer: get<number>('reminders.maxRemindersPerReviewer', 5),
      timeZone,
      quietHours: {
        enabled: get<boolean>('reminders.quietHours.enabled', false),
        start: get<string>('reminders.quietHours.start', '22:00'),
        end: get<string>('reminders.quietHours.end', '08:00'),
        quietDays: get<number[]>('reminders.quietHours.quietDays', []),
      },
      countCommentsAsResponse: get<boolean>('reminders.countCommentsAsResponse', false),
      remindAfterChangesRequested: get<boolean>('reminders.remindAfterChangesRequested', true),
    },
    alerts: {
      alertOnHistorical: get<boolean>('alerts.alertOnHistorical', false),
      severity: get<Record<string, 'high' | 'normal' | 'off'>>('alerts.severity', {}),
      importantCommentKeywords: get<string[]>('alerts.importantCommentKeywords', []),
    },
  };
}

/** Parses "login=email, login2=email2" (used by the setup wizard). */
export function parseReviewerPairs(input: string): { mapping: Record<string, string>; errors: string[] } {
  const mapping: Record<string, string> = {};
  const errors: string[] = [];
  for (const part of input.split(/[,\n;]+/).map((p) => p.trim()).filter(Boolean)) {
    const match = /^(@?[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9_.-]+)?)\s*[=:]\s*([^\s@]+@[^\s@]+\.[^\s@]+)$/.exec(part);
    if (!match) {
      errors.push(part);
      continue;
    }
    mapping[match[1] as string] = match[2] as string;
  }
  return { mapping, errors };
}

/** Only https links to the configured GitHub host are opened from the UI. */
export function isAllowedPrUrl(url: string, apiBaseUrl: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return false;
    }
    const api = new URL(apiBaseUrl);
    const webHost = api.hostname === 'api.github.com' ? 'github.com' : api.hostname;
    return parsed.hostname === webHost || parsed.hostname === 'github.com';
  } catch {
    return false;
  }
}
