import type { EventType, Severity } from '../../shared/events';
import type { Database } from './database';

export interface EventRow {
  id: number;
  event_key: string;
  pr_key: string;
  type: EventType;
  severity: Severity;
  summary: string;
  url: string;
  actor: string | null;
  occurred_at: string;
  recorded_at: string;
  historical: number;
  acknowledged_at: string | null;
}

export type NewEvent = Omit<EventRow, 'id' | 'recorded_at' | 'acknowledged_at'>;

export class EventRepository {
  constructor(private readonly db: Database) {}

  /**
   * Records an event if its unique key has not been seen before.
   * Returns the stored row when inserted, or null for a duplicate.
   */
  insertIfNew(event: NewEvent, now: Date): EventRow | null {
    const result = this.db.run(
      `INSERT OR IGNORE INTO events (event_key, pr_key, type, severity, summary, url, actor, occurred_at, recorded_at, historical,
         acknowledged_at)
       VALUES (:event_key, :pr_key, :type, :severity, :summary, :url, :actor, :occurred_at, :now, :historical,
         CASE WHEN :historical = 1 OR :severity = 'off' THEN :now ELSE NULL END)`,
      {
        event_key: event.event_key,
        pr_key: event.pr_key,
        type: event.type,
        severity: event.severity,
        summary: event.summary,
        url: event.url,
        actor: event.actor,
        occurred_at: event.occurred_at,
        historical: event.historical,
        now: now.toISOString(),
      },
    );
    if (result.changes === 0) {
      return null;
    }
    return this.db.get<EventRow>('SELECT * FROM events WHERE id = :id', { id: result.lastInsertRowid }) ?? null;
  }

  has(eventKey: string): boolean {
    return this.db.get('SELECT 1 AS x FROM events WHERE event_key = :eventKey', { eventKey }) !== undefined;
  }

  list(options: { sinceId?: number; limit?: number; includeHistorical?: boolean; prKey?: string } = {}): EventRow[] {
    return this.db.all<EventRow>(
      `SELECT * FROM events
       WHERE id > :sinceId AND (:includeHistorical = 1 OR historical = 0) AND (:prKey IS NULL OR pr_key = :prKey)
       ORDER BY id DESC LIMIT :limit`,
      {
        sinceId: options.sinceId ?? 0,
        limit: Math.min(Math.max(options.limit ?? 100, 1), 1000),
        includeHistorical: options.includeHistorical ? 1 : 0,
        prKey: options.prKey ?? null,
      },
    );
  }

  countUnacknowledged(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE acknowledged_at IS NULL')?.n ?? 0;
  }

  /** Marks alerts as seen. This is purely local and never touches GitHub review state. */
  acknowledge(ids: number[] | 'all', now: Date): number {
    if (ids === 'all') {
      return this.db.run('UPDATE events SET acknowledged_at = :now WHERE acknowledged_at IS NULL', { now: now.toISOString() }).changes;
    }
    let changed = 0;
    this.db.transaction(() => {
      for (const id of ids) {
        changed += this.db.run('UPDATE events SET acknowledged_at = :now WHERE id = :id AND acknowledged_at IS NULL', {
          id,
          now: now.toISOString(),
        }).changes;
      }
    });
    return changed;
  }
}
