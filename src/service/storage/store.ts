import { ChatSpaceRepository } from './chatSpaceRepository';
import { Database } from './database';
import { EventRepository } from './eventRepository';
import { KvRepository } from './kvRepository';
import { OutboxRepository } from './outboxRepository';
import { PrRepository } from './prRepository';
import { ReviewerRepository } from './reviewerRepository';

/** Aggregates all repositories over a single SQLite connection. */
export class Store {
  readonly db: Database;
  readonly kv: KvRepository;
  readonly prs: PrRepository;
  readonly reviewers: ReviewerRepository;
  readonly events: EventRepository;
  readonly outbox: OutboxRepository;
  readonly chatSpaces: ChatSpaceRepository;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.kv = new KvRepository(this.db);
    this.prs = new PrRepository(this.db);
    this.reviewers = new ReviewerRepository(this.db);
    this.events = new EventRepository(this.db);
    this.outbox = new OutboxRepository(this.db);
    this.chatSpaces = new ChatSpaceRepository(this.db);
  }

  close(): void {
    this.db.close();
  }
}

export const KV_KEYS = {
  baselineComplete: 'baseline_complete',
  baselineStartedAt: 'baseline_started_at',
  globalPaused: 'global_paused',
  lastSyncAt: 'last_sync_at',
  lastSyncError: 'last_sync_error',
} as const;
