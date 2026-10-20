import type { Database } from './database';

/** Caches the DM space name per reviewer email so each send needs one API call. */
export class ChatSpaceRepository {
  constructor(private readonly db: Database) {}

  get(email: string): string | null {
    return this.db.get<{ space_name: string }>('SELECT space_name FROM chat_spaces WHERE email = :email', { email: email.toLowerCase() })?.space_name ?? null;
  }

  set(email: string, spaceName: string, now = new Date()): void {
    this.db.run(
      `INSERT INTO chat_spaces (email, space_name, updated_at) VALUES (:email, :spaceName, :now)
       ON CONFLICT(email) DO UPDATE SET space_name = excluded.space_name, updated_at = excluded.updated_at`,
      { email: email.toLowerCase(), spaceName, now: now.toISOString() },
    );
  }

  delete(email: string): void {
    this.db.run('DELETE FROM chat_spaces WHERE email = :email', { email: email.toLowerCase() });
  }
}
