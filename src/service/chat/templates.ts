export interface PrMessageContext {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: string;
  reviewers: string[];
  reviewerLogin: string;
  reminderNumber?: number;
  maxReminders?: number;
  /** Re-requested or asked to re-review after requesting changes. */
  rereview?: boolean;
  /** Target app: Google Chat (default) supports <url|label> links; WhatsApp gets the plain URL. */
  channel?: 'chat' | 'whatsapp';
}

/**
 * Neutralises Google Chat text formatting in untrusted text (PR titles,
 * logins): no links (<url|text>), mentions (<users/…>), bold/italic/strike or
 * code. Lookalike characters keep the text readable.
 */
export function escapeChatText(value: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const escaped = clean
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/\*/g, '∗')
    .replace(/_/g, 'ˍ')
    .replace(/~/g, '∼')
    .replace(/`/g, 'ˋ');
  return escaped.length > max ? `${escaped.slice(0, max - 1)}…` : escaped;
}

/** Only https links are placed in messages; `|` and `>` would break Chat link syntax. */
export function safeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !/[|<>\s]/.test(parsed.toString()) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function humanizeDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

function prLink(ctx: PrMessageContext): string {
  const label = `${escapeChatText(ctx.repo)}#${ctx.number}: ${escapeChatText(ctx.title, 150)}`;
  const url = safeUrl(ctx.url);
  if (!url) {
    return label;
  }
  return ctx.channel === 'whatsapp' ? `${label}\n${url}` : `<${url}|${label}>`;
}

/** Tag at the start of every message so all messages about one PR are easy to spot in the DM. */
export function prTag(ctx: Pick<PrMessageContext, 'repo' | 'number'>): string {
  return `[${escapeChatText(ctx.repo)}#${ctx.number}]`;
}

export function renderInitialMessage(ctx: PrMessageContext): string {
  const reviewers = ctx.reviewers.map((r) => `@${escapeChatText(r, 60)}`).join(', ') || 'none';
  return [
    `${prTag(ctx)} 👋 *${ctx.rereview ? 'Your review is requested again' : 'Your review is requested'}*`,
    prLink(ctx),
    `Author: @${escapeChatText(ctx.author, 60)} · Reviewers: ${reviewers}`,
    '',
    'How to review: open the PR → *Files changed* → leave comments → *Review changes* → Comment, Approve or Request changes.',
    '_Submitting a review on GitHub stops these reminders._',
  ].join('\n');
}

export function renderReminderMessage(ctx: PrMessageContext, now: Date): string {
  const age = humanizeDuration(now.getTime() - Date.parse(ctx.createdAt));
  const counter = ctx.reminderNumber && ctx.maxReminders ? ` (reminder ${ctx.reminderNumber} of ${ctx.maxReminders})` : '';
  return [
    `${prTag(ctx)} ⏰ *Reminder: your review is still pending*${counter}`,
    prLink(ctx),
    `Opened ${age} ago by @${escapeChatText(ctx.author, 60)}.`,
    '_Submitting a review (Comment, Approve or Request changes) stops these reminders._',
  ].join('\n');
}
