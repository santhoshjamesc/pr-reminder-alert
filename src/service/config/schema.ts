import { z } from 'zod';
import { EVENT_TYPES } from '../../shared/events';

const repoName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Repository must look like "owner/name"');

/** GitHub login (user) or "@org/team-slug" for team review requests. */
export const reviewerKey = z
  .string()
  .trim()
  .regex(/^(@[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/, 'Invalid GitHub login or @org/team');

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24h HH:MM');

const timeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown IANA time zone');

/** International phone number; stored as digits only (country code first), the format WhatsApp links use. */
export const phoneNumber = z
  .string()
  .transform((v) => v.replace(/[\s().-]/g, '').replace(/^\+/, '').replace(/^00/, ''))
  .pipe(z.string().regex(/^[1-9]\d{7,14}$/, 'Use an international phone number with country code, e.g. +919876543210'));

const severity = z.enum(['high', 'normal', 'off']);

export const quietHoursSchema = z.object({
  enabled: z.boolean().default(false),
  start: hhmm.default('22:00'),
  end: hhmm.default('08:00'),
  /** Days (0 = Sunday) on which no email is sent at all, e.g. weekends. */
  quietDays: z.array(z.number().int().min(0).max(6)).default([]),
});

export const configSchema = z.object({
  github: z
    .object({
      username: z.string().trim().min(1).max(39).regex(/^[A-Za-z0-9-]+$/, 'Invalid GitHub username'),
      /** Empty list = every repository the token can access (uses the search API). */
      repositories: z.array(repoName).max(200).default([]),
      includeDrafts: z.boolean().default(true),
      pollIntervalSeconds: z.number().int().min(30).max(3600).default(120),
      apiBaseUrl: z.url().default('https://api.github.com'),
      /** Merged/closed PRs are left out of the PR list this many days after they merged or closed (0 = right away). */
      hideClosedPrsAfterDays: z.number().int().min(0).max(3650).default(7),
    })
    .strict(),
  /** GitHub login (or @org/team) -> Google Workspace email used to open a Google Chat DM. */
  reviewers: z.record(reviewerKey, z.email()).default({}),
  chat: z
    .object({
      enabled: z.boolean().default(true),
      sendInitialMessage: z.boolean().default(true),
      /** Send the "review requested" DM for PRs that already existed when the service first started. */
      sendInitialMessageForExistingPrs: z.boolean().default(false),
      maxAttempts: z.number().int().min(1).max(10).default(5),
    })
    .strict()
    .default({ enabled: true, sendInitialMessage: true, sendInitialMessageForExistingPrs: false, maxAttempts: 5 }),
  whatsapp: z
    .object({
      /** Send reviewer messages through WhatsApp Web from your own linked WhatsApp account. */
      enabled: z.boolean().default(false),
      /** Chrome/Chromium/Edge executable; empty = auto-detect. */
      chromePath: z.string().trim().max(1000).default(''),
      /** GitHub login (or @org/team) -> phone number with country code, e.g. +919876543210. */
      numbers: z.record(reviewerKey, phoneNumber).default({}),
    })
    .strict()
    .default({ enabled: false, chromePath: '', numbers: {} }),
  reminders: z
    .object({
      intervalMinutes: z.number().int().min(1).max(10080).default(30),
      maxRemindersPerReviewer: z.number().int().min(0).max(100).default(5),
      timeZone: timeZone.default('UTC'),
      quietHours: quietHoursSchema.default({ enabled: false, start: '22:00', end: '08:00', quietDays: [] }),
      /** If true, a plain or inline comment from a requested reviewer counts as a response. */
      countCommentsAsResponse: z.boolean().default(false),
      /** If true, reviewers who requested changes are reminded again once new commits are pushed. */
      remindAfterChangesRequested: z.boolean().default(true),
    })
    .strict()
    .default({
      intervalMinutes: 30,
      maxRemindersPerReviewer: 5,
      timeZone: 'UTC',
      quietHours: { enabled: false, start: '22:00', end: '08:00', quietDays: [] },
      countCommentsAsResponse: false,
      remindAfterChangesRequested: true,
    }),
  alerts: z
    .object({
      /** Alert on events discovered during the first synchronization (normally suppressed). */
      alertOnHistorical: z.boolean().default(false),
      severity: z.partialRecord(z.enum(EVENT_TYPES), severity).default({}),
      /** Comments from reviewers containing one of these words are "important" (high priority). Empty = every reviewer comment. */
      importantCommentKeywords: z.array(z.string().min(1).max(50)).max(50).default([]),
    })
    .strict()
    .default({ alertOnHistorical: false, severity: {}, importantCommentKeywords: [] }),
});

export type AppConfig = z.infer<typeof configSchema>;
export type AppConfigInput = z.input<typeof configSchema>;
export type QuietHours = z.infer<typeof quietHoursSchema>;

export function parseConfig(input: unknown): AppConfig {
  return configSchema.parse(input);
}

/** Lower-cases reviewer logins so lookups are case-insensitive (GitHub logins are). */
export function normalizeReviewerMap(map: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, email] of Object.entries(map)) {
    out.set(key.toLowerCase(), email.trim());
  }
  return out;
}

const secretsSchema = z.object({
  githubToken: z.string().min(1).optional(),
  googleClientId: z.string().min(1).optional(),
  googleClientSecret: z.string().min(1).optional(),
  googleRefreshToken: z.string().min(1).optional(),
  apiToken: z.string().min(32, 'PR_REMINDER_API_TOKEN must be at least 32 characters'),
});

export type Secrets = z.infer<typeof secretsSchema>;

/** Reads secrets from the environment. Values are validated but never logged. */
export function readSecrets(env: NodeJS.ProcessEnv): Secrets {
  const blank = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : undefined);
  return secretsSchema.parse({
    githubToken: blank(env.GITHUB_TOKEN),
    googleClientId: blank(env.GOOGLE_CLIENT_ID),
    googleClientSecret: blank(env.GOOGLE_CLIENT_SECRET),
    googleRefreshToken: blank(env.GOOGLE_REFRESH_TOKEN),
    apiToken: env.PR_REMINDER_API_TOKEN ?? '',
  });
}
