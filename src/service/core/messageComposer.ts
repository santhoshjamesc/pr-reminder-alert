import { type PrMessageContext, renderInitialMessage, renderReminderMessage } from '../chat/templates';
import type { AppConfig } from '../config/schema';
import type { PrRow } from '../storage/prRepository';
import type { ReviewerRow } from '../storage/reviewerRepository';
import type { OutboxChannel } from '../storage/outboxRepository';
import type { Store } from '../storage/store';
import { isQuietTime, nextAllowedTime } from './quietHours';
import { AWAITING_REREVIEW, emailFor, phoneFor } from './reviewerReconciler';

/** Builds Google Chat / WhatsApp messages for a reviewer and places them in the persistent outbox (idempotently). */
export class MessageComposer {
  constructor(private readonly store: Store) {}

  private context(pr: PrRow, reviewer: ReviewerRow, config: AppConfig): PrMessageContext {
    const reviewers = this.store.reviewers
      .listForPr(pr.pr_key)
      .filter((r) => r.status === 'pending')
      .map((r) => r.display_login);
    return {
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author,
      createdAt: pr.created_at,
      reviewers: reviewers.includes(reviewer.display_login) ? reviewers : [...reviewers, reviewer.display_login],
      reviewerLogin: reviewer.login,
      rereview: reviewer.cycle > 1 || reviewer.review_state === AWAITING_REREVIEW,
      maxReminders: config.reminders.maxRemindersPerReviewer,
    };
  }

  private sendAt(now: Date, config: AppConfig): string {
    const { quietHours, timeZone } = config.reminders;
    return (isQuietTime(now, quietHours, timeZone) ? nextAllowedTime(now, quietHours, timeZone) : now).toISOString();
  }

  /** Channels the reviewer can be reached on, with the recipient address for each. */
  private targets(reviewer: ReviewerRow, config: AppConfig): Array<{ channel: OutboxChannel; recipient: string; suffix: string }> {
    const out: Array<{ channel: OutboxChannel; recipient: string; suffix: string }> = [];
    const email = config.chat.enabled ? emailFor(reviewer.login, config) : null;
    if (email) {
      out.push({ channel: 'chat', recipient: email, suffix: '' });
    }
    const phone = config.whatsapp.enabled ? phoneFor(reviewer.login, config) : null;
    if (phone) {
      out.push({ channel: 'whatsapp', recipient: phone, suffix: ':wa' });
    }
    return out;
  }

  /** Queues the "review requested" message on every enabled channel. Returns true if anything was newly queued. */
  queueInitial(pr: PrRow, reviewer: ReviewerRow, config: AppConfig, now: Date): boolean {
    let queued = false;
    for (const target of this.targets(reviewer, config)) {
      queued =
        this.store.outbox.enqueue(
          {
            idem_key: `initial:${pr.pr_key}:${reviewer.login}:c${reviewer.cycle}${target.suffix}`,
            kind: 'initial',
            channel: target.channel,
            pr_key: pr.pr_key,
            reviewer_login: reviewer.login,
            recipient: target.recipient,
            text: renderInitialMessage({ ...this.context(pr, reviewer, config), channel: target.channel }),
            next_attempt_at: this.sendAt(now, config),
          },
          now,
        ) || queued;
    }
    if (queued) {
      this.store.db.run(
        'UPDATE reviewers SET initial_sent_at = :now, last_notified_at = :now WHERE pr_key = :prKey AND login = :login',
        { now: now.toISOString(), prKey: pr.pr_key, login: reviewer.login },
      );
    }
    return queued;
  }

  /** Queues reminder number `n` (1-based) for the reviewer's current cycle on every enabled channel. */
  queueReminder(pr: PrRow, reviewer: ReviewerRow, n: number, config: AppConfig, now: Date): boolean {
    let queued = false;
    for (const target of this.targets(reviewer, config)) {
      queued =
        this.store.outbox.enqueue(
          {
            idem_key: `reminder:${pr.pr_key}:${reviewer.login}:c${reviewer.cycle}:n${n}${target.suffix}`,
            kind: 'reminder',
            channel: target.channel,
            pr_key: pr.pr_key,
            reviewer_login: reviewer.login,
            recipient: target.recipient,
            text: renderReminderMessage({ ...this.context(pr, reviewer, config), reminderNumber: n, channel: target.channel }, now),
            next_attempt_at: now.toISOString(),
          },
          now,
        ) || queued;
    }
    return queued;
  }
}
