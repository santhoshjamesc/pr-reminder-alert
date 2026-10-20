import type { ReviewerStatus } from '../../shared/protocol';
import type { Database } from './database';

export interface ReviewerRow {
  pr_key: string;
  login: string;
  display_login: string;
  kind: 'user' | 'team';
  status: ReviewerStatus;
  review_state: string | null;
  responded_at: string | null;
  cycle: number;
  requested_at: string;
  initial_sent_at: string | null;
  last_notified_at: string | null;
  reminder_count: number;
  next_reminder_at: string | null;
}

export class ReviewerRepository {
  constructor(private readonly db: Database) {}

  listForPr(prKey: string): ReviewerRow[] {
    return this.db.all<ReviewerRow>('SELECT * FROM reviewers WHERE pr_key = :prKey ORDER BY login', { prKey });
  }

  get(prKey: string, login: string): ReviewerRow | undefined {
    return this.db.get<ReviewerRow>('SELECT * FROM reviewers WHERE pr_key = :prKey AND login = :login', { prKey, login });
  }

  listAllPending(): ReviewerRow[] {
    return this.db.all<ReviewerRow>(
      `SELECT r.* FROM reviewers r JOIN pull_requests p ON p.pr_key = r.pr_key
       WHERE r.status = 'pending' AND p.state = 'open'`,
    );
  }

  /** Pending reviewers whose next reminder is due, on open, unpaused, non-draft PRs. */
  listDue(now: Date): ReviewerRow[] {
    return this.db.all<ReviewerRow>(
      `SELECT r.* FROM reviewers r JOIN pull_requests p ON p.pr_key = r.pr_key
       WHERE r.status = 'pending' AND p.state = 'open' AND p.paused = 0 AND p.draft = 0
         AND r.next_reminder_at IS NOT NULL AND r.next_reminder_at <= :now
       ORDER BY r.next_reminder_at`,
      { now: now.toISOString() },
    );
  }

  insert(row: ReviewerRow): void {
    this.db.run(
      `INSERT INTO reviewers (pr_key, login, display_login, kind, status, review_state, responded_at, cycle, requested_at,
         initial_sent_at, last_notified_at, reminder_count, next_reminder_at)
       VALUES (:pr_key, :login, :display_login, :kind, :status, :review_state, :responded_at, :cycle, :requested_at,
         :initial_sent_at, :last_notified_at, :reminder_count, :next_reminder_at)`,
      { ...row },
    );
  }

  update(row: ReviewerRow): void {
    this.db.run(
      `UPDATE reviewers SET display_login = :display_login, kind = :kind, status = :status, review_state = :review_state,
         responded_at = :responded_at, cycle = :cycle, requested_at = :requested_at, initial_sent_at = :initial_sent_at,
         last_notified_at = :last_notified_at, reminder_count = :reminder_count, next_reminder_at = :next_reminder_at
       WHERE pr_key = :pr_key AND login = :login`,
      { ...row },
    );
  }

  /** Stops every scheduled reminder for a PR (merge/close/inaccessible). */
  clearSchedule(prKey: string): void {
    this.db.run('UPDATE reviewers SET next_reminder_at = NULL WHERE pr_key = :prKey', { prKey });
  }
}
