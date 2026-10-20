import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/schema';
import type { MessageDispatcher } from '../chat/dispatcher';
import type { Logger } from '../logging/logger';
import { KV_KEYS, type Store } from '../storage/store';
import type { MessageComposer } from './messageComposer';
import { isQuietTime, nextAllowedTime } from './quietHours';
import { hasMapping } from './reviewerReconciler';

export interface TickResult {
  skipped?: 'locked' | 'paused' | 'unconfigured';
  queued: number;
  deferred: number;
  stale: number;
  sent: number;
  failed: number;
}

/**
 * Persistent reminder scheduler. All state (counts, next reminder time) lives
 * in SQLite, so restarts neither lose nor duplicate reminders. Reminder rows
 * use idempotency keys and a database lease prevents concurrent ticks.
 */
export class ReminderEngine {
  private readonly owner = randomUUID();
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly composer: MessageComposer,
    private readonly dispatcher: MessageDispatcher,
    private readonly getConfig: () => AppConfig | null,
    private readonly logger: Logger,
  ) {}

  /** How old PR data may be before reminders are held back (GitHub state must be current). */
  static stalenessLimitMs(config: AppConfig): number {
    return config.github.pollIntervalSeconds * 3 * 1000 + 5 * 60_000;
  }

  async tick(now = new Date()): Promise<TickResult> {
    const result: TickResult = { queued: 0, deferred: 0, stale: 0, sent: 0, failed: 0 };
    const config = this.getConfig();
    if (!config) {
      return { ...result, skipped: 'unconfigured' };
    }
    if (this.running || !this.store.kv.tryAcquireLease('scheduler', this.owner, 5 * 60_000, now)) {
      return { ...result, skipped: 'locked' };
    }
    this.running = true;
    try {
      if (this.store.kv.getBool(KV_KEYS.globalPaused)) {
        return { ...result, skipped: 'paused' };
      }
      this.queueDueReminders(config, now, result);
      const delivery = await this.dispatcher.dispatchDue(now);
      result.sent = delivery.sent;
      result.failed = delivery.failed;
      return result;
    } finally {
      this.running = false;
      this.store.kv.releaseLease('scheduler', this.owner);
    }
  }

  private queueDueReminders(config: AppConfig, now: Date, result: TickResult): void {
    const { quietHours, timeZone, intervalMinutes, maxRemindersPerReviewer } = config.reminders;
    const staleLimit = ReminderEngine.stalenessLimitMs(config);
    for (const reviewer of this.store.reviewers.listDue(now)) {
      const pr = this.store.prs.get(reviewer.pr_key);
      if (!pr) {
        continue;
      }
      if (!pr.last_synced_at || now.getTime() - Date.parse(pr.last_synced_at) > staleLimit) {
        // We cannot confirm the reviewer is still pending on GitHub; wait for a successful sync.
        result.stale++;
        continue;
      }
      if (!hasMapping(reviewer.login, config) || reviewer.reminder_count >= maxRemindersPerReviewer) {
        this.store.reviewers.update({ ...reviewer, next_reminder_at: null });
        continue;
      }
      if (isQuietTime(now, quietHours, timeZone)) {
        this.store.reviewers.update({ ...reviewer, next_reminder_at: nextAllowedTime(now, quietHours, timeZone).toISOString() });
        result.deferred++;
        continue;
      }
      this.store.db.transaction(() => {
        const n = reviewer.reminder_count + 1;
        this.composer.queueReminder(pr, reviewer, n, config, now);
        // Even if the row already existed (crash recovery), advancing the counter keeps state consistent.
        this.store.reviewers.update({
          ...reviewer,
          reminder_count: n,
          last_notified_at: now.toISOString(),
          next_reminder_at: n >= maxRemindersPerReviewer ? null : new Date(now.getTime() + intervalMinutes * 60_000).toISOString(),
        });
      });
      result.queued++;
      this.logger.info('Reminder queued', { pr: pr.pr_key, reviewer: reviewer.login, n: reviewer.reminder_count + 1 });
    }
  }
}
