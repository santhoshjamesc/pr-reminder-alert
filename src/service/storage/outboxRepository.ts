import type { Database } from './database';

export type OutboxStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';
export type OutboxChannel = 'chat' | 'whatsapp';

export interface OutboxRow {
  id: number;
  idem_key: string;
  kind: 'initial' | 'reminder';
  /** Google Chat (recipient = Workspace email) or WhatsApp (recipient = phone digits). */
  channel: OutboxChannel;
  pr_key: string;
  reviewer_login: string;
  recipient: string;
  text: string;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
  sent_at: string | null;
  message_name: string | null;
}

export type NewOutbox = Pick<
  OutboxRow,
  'idem_key' | 'kind' | 'channel' | 'pr_key' | 'reviewer_login' | 'recipient' | 'text' | 'next_attempt_at'
>;

export class OutboxRepository {
  constructor(private readonly db: Database) {}

  /** Inserts a message unless one with the same idempotency key already exists. */
  enqueue(row: NewOutbox, now: Date): boolean {
    return (
      this.db.run(
        `INSERT OR IGNORE INTO message_outbox (idem_key, kind, channel, pr_key, reviewer_login, recipient, text, status, attempts,
           next_attempt_at, created_at)
         VALUES (:idem_key, :kind, :channel, :pr_key, :reviewer_login, :recipient, :text, 'queued', 0, :next_attempt_at, :now)`,
        {
          idem_key: row.idem_key,
          kind: row.kind,
          channel: row.channel,
          pr_key: row.pr_key,
          reviewer_login: row.reviewer_login,
          recipient: row.recipient,
          text: row.text,
          next_attempt_at: row.next_attempt_at,
          now: now.toISOString(),
        },
      ).changes > 0
    );
  }

  get(id: number): OutboxRow | undefined {
    return this.db.get<OutboxRow>('SELECT * FROM message_outbox WHERE id = :id', { id });
  }

  getByKey(idemKey: string): OutboxRow | undefined {
    return this.db.get<OutboxRow>('SELECT * FROM message_outbox WHERE idem_key = :idemKey', { idemKey });
  }

  listDue(now: Date, limit = 50): OutboxRow[] {
    return this.db.all<OutboxRow>(
      `SELECT * FROM message_outbox WHERE status = 'queued' AND next_attempt_at <= :now ORDER BY next_attempt_at LIMIT :limit`,
      { now: now.toISOString(), limit },
    );
  }

  list(status?: OutboxStatus, limit = 100): OutboxRow[] {
    return this.db.all<OutboxRow>(
      `SELECT * FROM message_outbox WHERE (:status IS NULL OR status = :status) ORDER BY id DESC LIMIT :limit`,
      { status: status ?? null, limit },
    );
  }

  count(status: OutboxStatus): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM message_outbox WHERE status = :status', { status })?.n ?? 0;
  }

  defer(id: number, nextAttemptAt: Date): void {
    this.db.run('UPDATE message_outbox SET next_attempt_at = :next WHERE id = :id', { id, next: nextAttemptAt.toISOString() });
  }

  /** Atomically claims a queued row for sending. Returns false if another worker claimed it. */
  claim(id: number): boolean {
    return this.db.run(`UPDATE message_outbox SET status = 'sending', attempts = attempts + 1 WHERE id = :id AND status = 'queued'`, { id })
      .changes > 0;
  }

  markSent(id: number, messageName: string | null, now: Date): void {
    this.db.run(`UPDATE message_outbox SET status = 'sent', sent_at = :now, message_name = :messageName, last_error = NULL WHERE id = :id`, {
      id,
      messageName,
      now: now.toISOString(),
    });
  }

  /** Puts a claimed row back in the queue. `refundAttempt` undoes the claim's attempt count (delivery was never tried). */
  markRetry(id: number, error: string, nextAttemptAt: Date, options: { refundAttempt?: boolean } = {}): void {
    this.db.run(
      `UPDATE message_outbox SET status = 'queued', last_error = :error, next_attempt_at = :next,
         attempts = MAX(0, attempts - :refund) WHERE id = :id`,
      { id, error, next: nextAttemptAt.toISOString(), refund: options.refundAttempt ? 1 : 0 },
    );
  }

  markFailed(id: number, error: string): void {
    this.db.run(`UPDATE message_outbox SET status = 'failed', last_error = :error WHERE id = :id`, { id, error });
  }

  cancel(id: number, reason: string): void {
    this.db.run(`UPDATE message_outbox SET status = 'cancelled', last_error = :reason WHERE id = :id`, { id, reason });
  }

  /** Cancels queued messages for a PR (e.g. merged) or for one reviewer. */
  cancelQueued(prKey: string, reviewerLogin: string | null, reason: string): number {
    return this.db.run(
      `UPDATE message_outbox SET status = 'cancelled', last_error = :reason
       WHERE pr_key = :prKey AND status = 'queued' AND (:login IS NULL OR reviewer_login = :login)`,
      { prKey, login: reviewerLogin, reason },
    ).changes;
  }

  /**
   * After a crash, rows left in 'sending' have unknown delivery status. They are
   * marked failed (not re-sent automatically) so a reviewer never gets a
   * duplicate; the user can retry them manually.
   */
  recoverInterrupted(): number {
    return this.db.run(
      `UPDATE message_outbox SET status = 'failed', last_error = 'Interrupted while sending; delivery unknown. Retry manually if needed.'
       WHERE status = 'sending'`,
    ).changes;
  }

  /** Re-queues failed messages for another delivery attempt. */
  requeueFailed(ids: number[] | 'all', now: Date): number {
    if (ids === 'all') {
      return this.db.run(`UPDATE message_outbox SET status = 'queued', attempts = 0, next_attempt_at = :now WHERE status = 'failed'`, {
        now: now.toISOString(),
      }).changes;
    }
    let n = 0;
    for (const id of ids) {
      n += this.db.run(
        `UPDATE message_outbox SET status = 'queued', attempts = 0, next_attempt_at = :now WHERE id = :id AND status = 'failed'`,
        { id, now: now.toISOString() },
      ).changes;
    }
    return n;
  }

  /** Dismisses failed messages without sending them. Rows stay as 'cancelled' so their idempotency key blocks a re-send. */
  dismissFailed(ids: number[] | 'all'): number {
    const reason = 'Cleared by user';
    if (ids === 'all') {
      return this.db.run(`UPDATE message_outbox SET status = 'cancelled', last_error = :reason WHERE status = 'failed'`, { reason }).changes;
    }
    let n = 0;
    for (const id of ids) {
      n += this.db.run(`UPDATE message_outbox SET status = 'cancelled', last_error = :reason WHERE id = :id AND status = 'failed'`, { id, reason }).changes;
    }
    return n;
  }
}
