import { safeErrorMessage } from '../../shared/redact';
import type { AppConfig } from '../config/schema';
import { isQuietTime, nextAllowedTime } from '../core/quietHours';
import type { Logger } from '../logging/logger';
import type { OutboxRow } from '../storage/outboxRepository';
import type { Store } from '../storage/store';
import { KV_KEYS } from '../storage/store';
import { WhatsAppError, type WhatsAppTransport } from '../whatsapp/whatsappWeb';
import { ChatError, type ChatNotifier } from './chatClient';

export const OUTBOX_BACKOFF = { baseDelayMs: 60_000, maxDelayMs: 60 * 60_000 };

/** How long WhatsApp messages wait before another try when WhatsApp is unusable (not linked, no browser). */
const WHATSAPP_UNAVAILABLE_RETRY_MS = 5 * 60_000;

/**
 * Delivers queued Google Chat DMs and WhatsApp messages from the persistent outbox. Each row is
 * claimed atomically before sending so concurrent runs cannot send the same
 * message twice, and relevance is re-checked against current reviewer state.
 */
export class MessageDispatcher {
  constructor(
    private readonly store: Store,
    private readonly getNotifier: () => ChatNotifier | null,
    private readonly getConfig: () => AppConfig | null,
    private readonly logger: Logger,
    private readonly getWhatsApp: () => WhatsAppTransport | null = () => null,
  ) {}

  async dispatchDue(now: Date): Promise<{ sent: number; failed: number; deferred: number; cancelled: number }> {
    const stats = { sent: 0, failed: 0, deferred: 0, cancelled: 0 };
    const config = this.getConfig();
    if (!config || this.store.kv.getBool(KV_KEYS.globalPaused)) {
      return stats;
    }
    const notifier = config.chat.enabled ? this.getNotifier() : null;
    const whatsapp = config.whatsapp.enabled ? this.getWhatsApp() : null;
    const { quietHours, timeZone } = config.reminders;
    for (const row of this.store.outbox.listDue(now)) {
      const irrelevant = this.irrelevantReason(row);
      if (irrelevant) {
        this.store.outbox.cancel(row.id, irrelevant);
        stats.cancelled++;
        continue;
      }
      if (this.store.prs.get(row.pr_key)?.paused) {
        continue; // stays queued until the PR is resumed
      }
      if (row.channel === 'chat' ? !notifier : !whatsapp?.isLinked()) {
        continue; // channel off or not set up yet: stays queued
      }
      if (isQuietTime(now, quietHours, timeZone)) {
        this.store.outbox.defer(row.id, nextAllowedTime(now, quietHours, timeZone));
        stats.deferred++;
        continue;
      }
      if (!this.store.outbox.claim(row.id)) {
        continue; // another worker claimed it
      }
      const attempts = row.attempts + 1;
      try {
        const messageName = row.channel === 'chat' ? await this.sendChat(notifier as ChatNotifier, row) : await this.sendWhatsApp(whatsapp as WhatsAppTransport, row);
        this.store.outbox.markSent(row.id, messageName, new Date());
        stats.sent++;
        this.logger.info('Message sent', { channel: row.channel, kind: row.kind, pr: row.pr_key, reviewer: row.reviewer_login });
      } catch (error) {
        const message = safeErrorMessage(error);
        if (error instanceof WhatsAppError && error.unavailable) {
          // Not the message's fault (logged out, no browser): wait without using up attempts.
          this.store.outbox.markRetry(row.id, message, new Date(now.getTime() + WHATSAPP_UNAVAILABLE_RETRY_MS), { refundAttempt: true });
          stats.deferred++;
          this.logger.warn('WhatsApp unavailable; message stays queued', { pr: row.pr_key, error: message });
          continue;
        }
        const transient = error instanceof ChatError || error instanceof WhatsAppError ? error.transient : true;
        if (transient && attempts < config.chat.maxAttempts) {
          const delay = Math.min(OUTBOX_BACKOFF.baseDelayMs * 2 ** (attempts - 1), OUTBOX_BACKOFF.maxDelayMs);
          this.store.outbox.markRetry(row.id, message, new Date(now.getTime() + delay));
        } else {
          this.store.outbox.markFailed(row.id, message);
          stats.failed++;
        }
        this.logger.warn('Message delivery failed', { channel: row.channel, kind: row.kind, pr: row.pr_key, attempts, transient, error: message });
      }
    }
    return stats;
  }

  private async sendChat(notifier: ChatNotifier, row: OutboxRow): Promise<string | null> {
    const space = await this.resolveSpace(notifier, row.recipient);
    try {
      return (await notifier.send(space, row.text)).name;
    } catch (error) {
      if (error instanceof ChatError && error.status === 404) {
        // Cached DM no longer exists: forget it so the next attempt looks it up again.
        this.store.chatSpaces.delete(row.recipient);
        throw new ChatError(error.message, true, 404);
      }
      throw error;
    }
  }

  private async sendWhatsApp(whatsapp: WhatsAppTransport, row: OutboxRow): Promise<null> {
    await whatsapp.send(row.recipient, row.text);
    return null;
  }

  private async resolveSpace(notifier: ChatNotifier, email: string): Promise<string> {
    const cached = this.store.chatSpaces.get(email);
    if (cached) {
      return cached;
    }
    const space = await notifier.findOrCreateDm(email);
    this.store.chatSpaces.set(email, space);
    return space;
  }

  private irrelevantReason(row: OutboxRow): string | null {
    const pr = this.store.prs.get(row.pr_key);
    if (!pr || pr.state !== 'open') {
      return `PR is ${pr?.state ?? 'unknown'}`;
    }
    const reviewer = this.store.reviewers.get(row.pr_key, row.reviewer_login);
    if (!reviewer || reviewer.status !== 'pending') {
      return 'Reviewer no longer pending';
    }
    return null;
  }
}
