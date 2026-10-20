import type { AppConfig } from '../config/schema';
import type { PrSnapshot, ReviewSnapshot } from '../github/types';
import { prKeyOf } from '../github/types';
import type { NewEvent } from '../storage/eventRepository';
import type { ReviewerRow } from '../storage/reviewerRepository';
import { severityFor } from './eventDetector';

/** Marker review_state for reviewers asked to re-review after requesting changes. */
export const AWAITING_REREVIEW = 'AWAITING_REREVIEW';

/** Review states that count as "the reviewer responded". */
export const RESPONSE_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']);

export interface ReconcileContext {
  config: AppConfig;
  now: Date;
  /** Suppress alerts (baseline) for generated events. */
  historical: boolean;
  /** Queue "review requested" DMs for newly pending reviewers. */
  sendInitialMessages: boolean;
}

export interface ReconcileResult {
  inserts: ReviewerRow[];
  updates: ReviewerRow[];
  events: NewEvent[];
  /** Reviewers (row snapshots after reconciliation) that should receive the initial DM. */
  initialMessages: ReviewerRow[];
  /** Reviewers that stopped being pending; their queued messages must be cancelled. */
  stopped: ReviewerRow[];
}

function iso(date: Date): string {
  return date.toISOString();
}

/**
 * True when `review` is a submitted review. A COMMENTED review with an empty
 * body that only wraps inline comments ("Add single comment") is treated as
 * an inline comment, which only counts if `countCommentsAsResponse` is on.
 */
export function isSubmittedReview(review: ReviewSnapshot, snap: PrSnapshot, countComments: boolean): boolean {
  if (!RESPONSE_STATES.has(review.state) || !review.submittedAt) {
    return false;
  }
  if (review.state === 'COMMENTED' && !countComments) {
    const inlineOnly = review.body.trim() === '' && snap.reviewComments.some((c) => c.reviewId === review.id);
    if (inlineOnly) {
      return false;
    }
  }
  return true;
}

function latestResponse(login: string, snap: PrSnapshot, after: string | null, countComments: boolean): { state: string; at: string } | null {
  let best: { state: string; at: string } | null = null;
  for (const review of snap.reviews) {
    if (review.user.toLowerCase() !== login || !isSubmittedReview(review, snap, countComments)) {
      continue;
    }
    const at = review.submittedAt as string;
    if ((after === null || at > after) && (!best || at > best.at)) {
      best = { state: review.state, at };
    }
  }
  if (countComments) {
    for (const c of [...snap.issueComments, ...snap.reviewComments]) {
      if (c.user.toLowerCase() === login && (after === null || c.createdAt > after) && (!best || c.createdAt > best.at)) {
        best = { state: 'COMMENTED_ONLY', at: c.createdAt };
      }
    }
  }
  return best;
}

/** For team requests we cannot know members; any non-author review after the request counts. */
function latestTeamResponse(snap: PrSnapshot, after: string): { state: string; at: string } | null {
  const author = snap.author.toLowerCase();
  let best: { state: string; at: string } | null = null;
  for (const review of snap.reviews) {
    if (review.user.toLowerCase() === author || !RESPONSE_STATES.has(review.state) || !review.submittedAt) {
      continue;
    }
    if (review.submittedAt > after && (!best || review.submittedAt > best.at)) {
      best = { state: review.state, at: review.submittedAt };
    }
  }
  return best;
}

/** True if the reviewer can be reached on at least one channel (Chat email, or WhatsApp number while WhatsApp is on). */
export function hasMapping(login: string, config: AppConfig): boolean {
  return emailFor(login, config) !== null || (config.whatsapp.enabled && phoneFor(login, config) !== null);
}

function lookup(map: Record<string, string>, login: string): string | null {
  const wanted = login.toLowerCase();
  for (const [key, value] of Object.entries(map)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return null;
}

export function emailFor(login: string, config: AppConfig): string | null {
  return lookup(config.reviewers, login);
}

/** WhatsApp number (digits, country code first) mapped to the reviewer, if any. */
export function phoneFor(login: string, config: AppConfig): string | null {
  return lookup(config.whatsapp.numbers, login);
}

function scheduleFirst(login: string, config: AppConfig, now: Date): string | null {
  if (!hasMapping(login, config) || config.reminders.maxRemindersPerReviewer === 0) {
    return null;
  }
  return iso(new Date(now.getTime() + config.reminders.intervalMinutes * 60_000));
}

/**
 * Reconciles stored reviewer state with GitHub's actual requested reviewers
 * and submitted reviews. Every reviewer's state is independent: one approval
 * never resolves another reviewer's request.
 */
export function reconcileReviewers(existing: ReviewerRow[], snap: PrSnapshot, ctx: ReconcileContext): ReconcileResult {
  const { config, now } = ctx;
  const prKey = prKeyOf(snap);
  const result: ReconcileResult = { inserts: [], updates: [], events: [], initialMessages: [], stopped: [] };
  const byLogin = new Map(existing.map((r) => [r.login, r]));
  const requested = new Map<string, { display: string; kind: 'user' | 'team' }>();
  for (const u of snap.requestedUsers) {
    requested.set(u.toLowerCase(), { display: u, kind: 'user' });
  }
  for (const t of snap.requestedTeams) {
    requested.set(t.toLowerCase(), { display: t, kind: 'team' });
  }
  const countComments = config.reminders.countCommentsAsResponse;
  const pollSlackMs = config.github.pollIntervalSeconds * 1000;

  const event = (type: 'review_requested' | 'review_request_removed', row: ReviewerRow, summary: string) => {
    result.events.push({
      event_key: `${type}:${prKey}:${row.login}:${row.cycle}`,
      pr_key: prKey,
      type,
      severity: severityFor(type, config),
      summary,
      url: snap.url,
      actor: row.display_login,
      occurred_at: iso(now),
      historical: ctx.historical ? 1 : 0,
    });
  };

  const startCycle = (row: ReviewerRow, awaitingRereview: boolean) => {
    row.status = 'pending';
    row.review_state = awaitingRereview ? AWAITING_REREVIEW : null;
    row.requested_at = iso(now);
    row.initial_sent_at = null;
    row.reminder_count = 0;
    row.next_reminder_at = scheduleFirst(row.login, config, now);
    if (ctx.sendInitialMessages && config.chat.sendInitialMessage && hasMapping(row.login, config)) {
      result.initialMessages.push(row);
    }
  };

  for (const [login, info] of requested) {
    if (login === snap.author.toLowerCase()) {
      continue;
    }
    const row = byLogin.get(login);
    if (!row) {
      const fresh: ReviewerRow = {
        pr_key: prKey,
        login,
        display_login: info.display,
        kind: info.kind,
        status: 'pending',
        review_state: null,
        responded_at: null,
        cycle: 1,
        requested_at: iso(now),
        initial_sent_at: null,
        last_notified_at: null,
        reminder_count: 0,
        next_reminder_at: null,
      };
      startCycle(fresh, false);
      result.inserts.push(fresh);
      event('review_requested', fresh, `Review requested from @${info.display}`);
      continue;
    }
    if (row.status !== 'pending') {
      // Re-requested after responding or after the request had been removed: new reminder cycle.
      const updated: ReviewerRow = { ...row, cycle: row.cycle + 1 };
      startCycle(updated, false);
      result.updates.push(updated);
      event('review_requested', updated, `Review re-requested from @${info.display}`);
      continue;
    }
    // Still requested. With countCommentsAsResponse, a comment after the request resolves it.
    if (countComments) {
      const after = new Date(Date.parse(row.requested_at) - pollSlackMs).toISOString();
      const response = latestResponse(login, snap, row.responded_at && row.responded_at > after ? row.responded_at : after, true);
      if (response) {
        const updated: ReviewerRow = { ...row, status: 'responded', review_state: response.state, responded_at: response.at, next_reminder_at: null };
        result.updates.push(updated);
        result.stopped.push(updated);
        continue;
      }
    }
    if (row.next_reminder_at === null && row.reminder_count < config.reminders.maxRemindersPerReviewer && hasMapping(login, config)) {
      // Self-heal: e.g. an email mapping was added after the request was first seen.
      result.updates.push({ ...row, next_reminder_at: scheduleFirst(login, config, now) });
      if (!row.initial_sent_at && ctx.sendInitialMessages && config.chat.sendInitialMessage) {
        result.initialMessages.push(row);
      }
    }
  }

  for (const row of existing) {
    if (requested.has(row.login)) {
      continue;
    }
    if (row.status === 'pending') {
      const response =
        row.kind === 'team'
          ? latestTeamResponse(snap, new Date(Date.parse(row.requested_at) - pollSlackMs).toISOString())
          : latestResponse(row.login, snap, row.responded_at, countComments);
      if (response) {
        const updated: ReviewerRow = { ...row, status: 'responded', review_state: response.state, responded_at: response.at, next_reminder_at: null };
        result.updates.push(updated);
        result.stopped.push(updated);
      } else if (row.review_state === AWAITING_REREVIEW) {
        // Re-review cycle we started ourselves (no GitHub request exists); keep it until they review again.
        continue;
      } else if (row.kind === 'user' && hasInlineOnlyActivity(row.login, snap)) {
        // GitHub dropped the request because of an inline-only comment. That does not count as a review here.
        continue;
      } else {
        const updated: ReviewerRow = { ...row, status: 'removed', next_reminder_at: null };
        result.updates.push(updated);
        result.stopped.push(updated);
        event('review_request_removed', updated, `Review request for @${row.display_login} removed`);
      }
      continue;
    }
    if (
      row.status === 'responded' &&
      row.review_state === 'CHANGES_REQUESTED' &&
      config.reminders.remindAfterChangesRequested &&
      row.responded_at &&
      snap.commits.some((c) => c.date !== null && c.date > (row.responded_at as string))
    ) {
      // New commits after changes were requested: ask the reviewer to re-review.
      const updated: ReviewerRow = { ...row, cycle: row.cycle + 1 };
      startCycle(updated, true);
      result.updates.push(updated);
      event('review_requested', updated, `Re-review needed from @${row.display_login} (changes were requested, new commits pushed)`);
    }
  }

  // Reviewers who already submitted a review (so GitHub dropped their request, e.g. before monitoring
  // started) are recorded as responded so the UI shows them. No events or messages are generated.
  const known = new Set([...byLogin.keys(), ...requested.keys(), ...result.inserts.map((r) => r.login)]);
  for (const review of snap.reviews) {
    const login = review.user.toLowerCase();
    if (!login || login === snap.author.toLowerCase() || known.has(login) || !isSubmittedReview(review, snap, countComments)) {
      continue;
    }
    const response = latestResponse(login, snap, null, countComments);
    if (!response) {
      continue;
    }
    known.add(login);
    result.inserts.push({
      pr_key: prKey,
      login,
      display_login: review.user,
      kind: 'user',
      status: 'responded',
      review_state: response.state,
      responded_at: response.at,
      cycle: 1,
      requested_at: response.at,
      initial_sent_at: null,
      last_notified_at: null,
      reminder_count: 0,
      next_reminder_at: null,
    });
  }

  return result;
}

function hasInlineOnlyActivity(login: string, snap: PrSnapshot): boolean {
  return snap.reviews.some((r) => r.user.toLowerCase() === login && r.state === 'COMMENTED' && !isSubmittedReview(r, snap, false));
}
