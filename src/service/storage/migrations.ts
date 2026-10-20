/**
 * Ordered schema migrations. The applied version is stored in SQLite's
 * `PRAGMA user_version`. Never edit a released migration; append a new one.
 */
export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'initial schema',
    sql: `
      CREATE TABLE kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE pull_requests (
        pr_key TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        body_hash TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        author TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'merged', 'closed', 'inaccessible')),
        draft INTEGER NOT NULL DEFAULT 0,
        head_sha TEXT NOT NULL DEFAULT '',
        head_ref TEXT NOT NULL DEFAULT '',
        branch_deleted INTEGER NOT NULL DEFAULT 0,
        labels TEXT NOT NULL DEFAULT '[]',
        assignees TEXT NOT NULL DEFAULT '[]',
        ci_state TEXT NOT NULL DEFAULT 'none',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        merged_at TEXT,
        first_seen_at TEXT NOT NULL,
        last_synced_at TEXT,
        discovered_in_baseline INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_pr_state ON pull_requests(state);

      CREATE TABLE reviewers (
        pr_key TEXT NOT NULL REFERENCES pull_requests(pr_key) ON DELETE CASCADE,
        login TEXT NOT NULL,
        display_login TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('user', 'team')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'responded', 'removed')),
        review_state TEXT,
        responded_at TEXT,
        cycle INTEGER NOT NULL DEFAULT 1,
        requested_at TEXT NOT NULL,
        initial_sent_at TEXT,
        last_notified_at TEXT,
        reminder_count INTEGER NOT NULL DEFAULT 0,
        next_reminder_at TEXT,
        PRIMARY KEY (pr_key, login)
      );
      CREATE INDEX idx_reviewers_due ON reviewers(status, next_reminder_at);

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        pr_key TEXT NOT NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL,
        url TEXT NOT NULL,
        actor TEXT,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        historical INTEGER NOT NULL DEFAULT 0,
        acknowledged_at TEXT
      );
      CREATE INDEX idx_events_pr ON events(pr_key);

      CREATE TABLE email_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idem_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('initial', 'reminder')),
        pr_key TEXT NOT NULL,
        reviewer_login TEXT NOT NULL,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        text_body TEXT NOT NULL,
        html_body TEXT NOT NULL,
        headers TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        message_id TEXT
      );
      CREATE INDEX idx_outbox_status ON email_outbox(status, next_attempt_at);
    `,
  },
  {
    version: 2,
    description: 'replace email outbox with Google Chat message outbox',
    sql: `
      DROP TABLE IF EXISTS email_outbox;

      CREATE TABLE message_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idem_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('initial', 'reminder')),
        pr_key TEXT NOT NULL,
        reviewer_login TEXT NOT NULL,
        recipient TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        message_name TEXT
      );
      CREATE INDEX idx_message_outbox_status ON message_outbox(status, next_attempt_at);

      CREATE TABLE chat_spaces (
        email TEXT PRIMARY KEY,
        space_name TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    description: 'delivery channel per outbox message (Google Chat or WhatsApp)',
    sql: `
      ALTER TABLE message_outbox ADD COLUMN channel TEXT NOT NULL DEFAULT 'chat' CHECK (channel IN ('chat', 'whatsapp'));
    `,
  },
];
