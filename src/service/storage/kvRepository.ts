import type { Database } from './database';

export class KvRepository {
  constructor(private readonly db: Database) {}

  get(key: string): string | null {
    return this.db.get<{ value: string }>('SELECT value FROM kv WHERE key = :key', { key })?.value ?? null;
  }

  set(key: string, value: string, now = new Date()): void {
    this.db.run(
      `INSERT INTO kv (key, value, updated_at) VALUES (:key, :value, :now)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      { key, value, now: now.toISOString() },
    );
  }

  delete(key: string): void {
    this.db.run('DELETE FROM kv WHERE key = :key', { key });
  }

  getBool(key: string): boolean {
    return this.get(key) === 'true';
  }

  /**
   * Acquires (or renews) a named lease. Used so two service processes sharing
   * a database, or two overlapping ticks, never run the scheduler at once.
   */
  tryAcquireLease(name: string, owner: string, ttlMs: number, now = new Date()): boolean {
    const key = `lease:${name}`;
    return this.db.transaction(() => {
      const row = this.db.get<{ value: string }>('SELECT value FROM kv WHERE key = :key', { key });
      if (row) {
        const lease = JSON.parse(row.value) as { owner: string; expiresAt: string };
        if (lease.owner !== owner && Date.parse(lease.expiresAt) > now.getTime()) {
          return false;
        }
      }
      this.set(key, JSON.stringify({ owner, expiresAt: new Date(now.getTime() + ttlMs).toISOString() }), now);
      return true;
    });
  }

  releaseLease(name: string, owner: string): void {
    const key = `lease:${name}`;
    this.db.transaction(() => {
      const row = this.db.get<{ value: string }>('SELECT value FROM kv WHERE key = :key', { key });
      if (row && (JSON.parse(row.value) as { owner: string }).owner === owner) {
        this.delete(key);
      }
    });
  }
}
