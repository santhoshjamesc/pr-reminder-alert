import type { CiState, PrState } from '../../shared/protocol';
import type { Database } from './database';

export interface PrRow {
  pr_key: string;
  repo: string;
  number: number;
  title: string;
  body_hash: string;
  url: string;
  author: string;
  state: PrState;
  draft: number;
  head_sha: string;
  head_ref: string;
  branch_deleted: number;
  labels: string;
  assignees: string;
  ci_state: CiState;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  first_seen_at: string;
  last_synced_at: string | null;
  discovered_in_baseline: number;
  paused: number;
  consecutive_failures: number;
}

export type PrUpsert = Omit<PrRow, 'first_seen_at' | 'paused' | 'consecutive_failures'>;

export class PrRepository {
  constructor(private readonly db: Database) {}

  get(prKey: string): PrRow | undefined {
    return this.db.get<PrRow>('SELECT * FROM pull_requests WHERE pr_key = :prKey', { prKey });
  }

  list(): PrRow[] {
    return this.db.all<PrRow>('SELECT * FROM pull_requests ORDER BY updated_at DESC');
  }

  listByState(state: PrState): PrRow[] {
    return this.db.all<PrRow>('SELECT * FROM pull_requests WHERE state = :state ORDER BY updated_at DESC', { state });
  }

  upsert(row: PrUpsert, now: Date): void {
    this.db.run(
      `INSERT INTO pull_requests (
         pr_key, repo, number, title, body_hash, url, author, state, draft, head_sha, head_ref, branch_deleted,
         labels, assignees, ci_state, created_at, updated_at, closed_at, merged_at, first_seen_at, last_synced_at,
         discovered_in_baseline, consecutive_failures)
       VALUES (
         :pr_key, :repo, :number, :title, :body_hash, :url, :author, :state, :draft, :head_sha, :head_ref, :branch_deleted,
         :labels, :assignees, :ci_state, :created_at, :updated_at, :closed_at, :merged_at, :now, :last_synced_at,
         :discovered_in_baseline, 0)
       ON CONFLICT(pr_key) DO UPDATE SET
         title = excluded.title, body_hash = excluded.body_hash, url = excluded.url, author = excluded.author,
         state = excluded.state, draft = excluded.draft, head_sha = excluded.head_sha, head_ref = excluded.head_ref,
         branch_deleted = excluded.branch_deleted, labels = excluded.labels, assignees = excluded.assignees,
         ci_state = excluded.ci_state, created_at = excluded.created_at, updated_at = excluded.updated_at,
         closed_at = excluded.closed_at, merged_at = excluded.merged_at, last_synced_at = excluded.last_synced_at,
         consecutive_failures = 0`,
      { ...row, now: now.toISOString() },
    );
  }

  setState(prKey: string, state: PrState): void {
    this.db.run('UPDATE pull_requests SET state = :state WHERE pr_key = :prKey', { prKey, state });
  }

  recordFailure(prKey: string): number {
    this.db.run('UPDATE pull_requests SET consecutive_failures = consecutive_failures + 1 WHERE pr_key = :prKey', { prKey });
    return this.get(prKey)?.consecutive_failures ?? 0;
  }

  setPaused(prKey: string, paused: boolean): boolean {
    return this.db.run('UPDATE pull_requests SET paused = :paused WHERE pr_key = :prKey', { prKey, paused: paused ? 1 : 0 }).changes > 0;
  }
}
