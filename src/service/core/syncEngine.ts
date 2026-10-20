import { safeErrorMessage } from '../../shared/redact';
import type { AppConfig } from '../config/schema';
import { type GitHubGateway, type PrRef, type PrSnapshot, GitHubAccessError, GitHubTransientError, prKeyOf } from '../github/types';
import type { Logger } from '../logging/logger';
import type { EventRow } from '../storage/eventRepository';
import type { PrRow } from '../storage/prRepository';
import { KV_KEYS, type Store } from '../storage/store';
import type { MessageComposer } from './messageComposer';
import { detectEvents, severityFor } from './eventDetector';
import { shortHash } from './hash';
import { reconcileReviewers } from './reviewerReconciler';

export interface SyncResult {
  prsSynced: number;
  newEvents: EventRow[];
  errors: string[];
  baselineCompleted: boolean;
  /** Set when GitHub asked us to back off. */
  retryAfterMs?: number;
}

/** After this many consecutive 403/404 responses a PR is considered inaccessible. */
const INACCESSIBLE_AFTER_FAILURES = 3;

/**
 * Polls GitHub for the configured user's pull requests, turns differences
 * into deduplicated events, and keeps per-reviewer state in step with
 * GitHub's actual requested reviewers and submitted reviews.
 */
export class SyncEngine {
  private running: Promise<SyncResult> | null = null;

  constructor(
    private readonly store: Store,
    private readonly getGateway: () => GitHubGateway | null,
    private readonly getConfig: () => AppConfig | null,
    private readonly composer: MessageComposer,
    private readonly logger: Logger,
  ) {}

  /** Runs a sync; concurrent callers share the in-flight run. */
  sync(now = new Date()): Promise<SyncResult> {
    if (!this.running) {
      this.running = this.doSync(now).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async doSync(now: Date): Promise<SyncResult> {
    const result: SyncResult = { prsSynced: 0, newEvents: [], errors: [], baselineCompleted: false };
    const config = this.getConfig();
    const gateway = this.getGateway();
    if (!config || !gateway) {
      result.errors.push(!config ? 'Service is not configured yet' : 'GitHub token is not configured');
      this.store.kv.set(KV_KEYS.lastSyncError, result.errors[0] ?? '', now);
      return result;
    }
    const { kv } = this.store;
    const baselineMode = !kv.getBool(KV_KEYS.baselineComplete);
    if (!kv.get(KV_KEYS.baselineStartedAt)) {
      kv.set(KV_KEYS.baselineStartedAt, now.toISOString(), now);
    }
    const baselineStartedAt = kv.get(KV_KEYS.baselineStartedAt) as string;

    let discovered: PrRef[];
    try {
      discovered = await gateway.discoverAuthoredOpenPrs(config.github.username, config.github.repositories);
    } catch (error) {
      return this.fail(result, error, now);
    }

    const monitoredRepos = new Set(config.github.repositories.map((r) => r.toLowerCase()));
    const inScope = (pr: Pick<PrRow, 'repo' | 'author'>) =>
      (monitoredRepos.size === 0 || monitoredRepos.has(pr.repo.toLowerCase())) && pr.author.toLowerCase() === config.github.username.toLowerCase();

    // Also re-check PRs we track as open, so merges/closures are noticed even though they left the "open" list.
    const refs = new Map<string, PrRef>();
    for (const ref of discovered) {
      refs.set(prKeyOf(ref), ref);
    }
    for (const pr of this.store.prs.listByState('open')) {
      if (inScope(pr)) {
        refs.set(pr.pr_key, { repo: pr.repo, number: pr.number });
      } else {
        // Repository removed from config or username changed: stop reminders for it.
        this.store.reviewers.clearSchedule(pr.pr_key);
      }
    }

    let fatal = false;
    for (const ref of refs.values()) {
      try {
        const snap = await gateway.fetchSnapshot(ref);
        if (snap.author.toLowerCase() !== config.github.username.toLowerCase()) {
          continue;
        }
        if (!config.github.includeDrafts && snap.draft && !this.store.prs.get(prKeyOf(snap))) {
          continue;
        }
        result.newEvents.push(...this.applySnapshot(snap, config, now, baselineMode, baselineStartedAt));
        result.prsSynced++;
      } catch (error) {
        if (error instanceof GitHubAccessError && error.status !== 401) {
          result.newEvents.push(...this.handleInaccessible(ref, error, config, now, baselineMode));
          continue;
        }
        result.errors.push(`${prKeyOf(ref)}: ${safeErrorMessage(error)}`);
        if (error instanceof GitHubTransientError && error.retryAfterMs) {
          result.retryAfterMs = error.retryAfterMs;
        }
        if (error instanceof GitHubTransientError || (error instanceof GitHubAccessError && error.status === 401)) {
          fatal = true;
          break; // network/rate-limit/auth problem: stop this round and retry later
        }
        this.logger.error('Failed to sync pull request', { pr: prKeyOf(ref), error: safeErrorMessage(error) });
      }
    }

    if (baselineMode && !fatal) {
      kv.set(KV_KEYS.baselineComplete, 'true', now);
      result.baselineCompleted = true;
      this.logger.info('Initial synchronization complete; baseline established', { prs: result.prsSynced });
    }
    kv.set(KV_KEYS.lastSyncAt, now.toISOString(), now);
    if (result.errors.length > 0) {
      kv.set(KV_KEYS.lastSyncError, result.errors.slice(0, 3).join('; '), now);
    } else {
      kv.delete(KV_KEYS.lastSyncError);
    }
    return result;
  }

  private fail(result: SyncResult, error: unknown, now: Date): SyncResult {
    const message = safeErrorMessage(error);
    result.errors.push(message);
    if (error instanceof GitHubTransientError && error.retryAfterMs) {
      result.retryAfterMs = error.retryAfterMs;
    }
    this.store.kv.set(KV_KEYS.lastSyncError, message, now);
    this.logger.warn('GitHub sync failed', { error: message });
    return result;
  }

  /** Applies one PR snapshot atomically: events, reviewer state, PR row, Chat messages. */
  applySnapshot(snap: PrSnapshot, config: AppConfig, now: Date, baselineMode: boolean, baselineStartedAt: string): EventRow[] {
    const prKey = prKeyOf(snap);
    return this.store.db.transaction(() => {
      const prev = this.store.prs.get(prKey);
      const existingReviewers = this.store.reviewers.listForPr(prKey);
      // PRs found during the first sync, or that pre-date monitoring (e.g. a repository added later), are history.
      const preExisting = baselineMode || (prev === undefined && snap.createdAt < baselineStartedAt);
      const historical = preExisting && !config.alerts.alertOnHistorical;

      const reviewerLogins = new Set([
        ...existingReviewers.map((r) => r.login),
        ...snap.requestedUsers.map((u) => u.toLowerCase()),
      ]);
      const events = detectEvents(prev, snap, { config, reviewerLogins, historical });

      const state = snap.merged ? 'merged' : snap.state;
      const isOpen = state === 'open';
      const reconcile = isOpen
        ? reconcileReviewers(existingReviewers, snap, {
            config,
            now,
            historical,
            sendInitialMessages: !preExisting || config.chat.sendInitialMessageForExistingPrs,
          })
        : null;

      this.store.prs.upsert(
        {
          pr_key: prKey,
          repo: snap.repo,
          number: snap.number,
          title: snap.title,
          body_hash: shortHash(snap.body),
          url: snap.url,
          author: snap.author,
          state,
          draft: snap.draft ? 1 : 0,
          head_sha: snap.headSha,
          head_ref: snap.headRef,
          branch_deleted: snap.headRepoMissing ? 1 : 0,
          labels: JSON.stringify([...snap.labels].sort()),
          assignees: JSON.stringify([...snap.assignees].sort()),
          ci_state: snap.ci.state,
          created_at: snap.createdAt,
          updated_at: snap.updatedAt,
          closed_at: snap.closedAt,
          merged_at: snap.mergedAt,
          last_synced_at: now.toISOString(),
          discovered_in_baseline: preExisting ? 1 : 0,
        },
        now,
      );

      if (reconcile) {
        for (const row of reconcile.inserts) {
          this.store.reviewers.insert(row);
        }
        for (const row of reconcile.updates) {
          this.store.reviewers.update(row);
        }
        for (const row of reconcile.stopped) {
          this.store.outbox.cancelQueued(prKey, row.login, 'Reviewer responded or request removed');
        }
        events.push(...reconcile.events);
      } else {
        // Merged or closed: stop every reminder for this PR.
        this.store.reviewers.clearSchedule(prKey);
        this.store.outbox.cancelQueued(prKey, null, `PR ${state}`);
      }

      const inserted: EventRow[] = [];
      for (const event of events) {
        const row = this.store.events.insertIfNew(event, now);
        if (row && !row.historical && row.severity !== 'off') {
          inserted.push(row);
        }
      }

      if (reconcile && (config.chat.enabled || config.whatsapp.enabled)) {
        const pr = this.store.prs.get(prKey) as PrRow;
        if (!pr.draft) {
          for (const reviewer of reconcile.initialMessages) {
            this.composer.queueInitial(pr, this.store.reviewers.get(prKey, reviewer.login) ?? reviewer, config, now);
          }
        }
      }
      return inserted;
    });
  }

  private handleInaccessible(ref: PrRef, error: GitHubAccessError, config: AppConfig, now: Date, baselineMode: boolean): EventRow[] {
    const prKey = prKeyOf(ref);
    const existing = this.store.prs.get(prKey);
    this.logger.warn('Pull request not accessible', { pr: prKey, status: error.status });
    if (!existing || existing.state !== 'open') {
      return [];
    }
    const failures = this.store.prs.recordFailure(prKey);
    if (failures < INACCESSIBLE_AFTER_FAILURES) {
      return [];
    }
    return this.store.db.transaction(() => {
      this.store.prs.setState(prKey, 'inaccessible');
      this.store.reviewers.clearSchedule(prKey);
      this.store.outbox.cancelQueued(prKey, null, 'PR inaccessible (deleted or permission lost)');
      const row = this.store.events.insertIfNew(
        {
          event_key: `pr_inaccessible:${prKey}:${now.toISOString().slice(0, 10)}`,
          pr_key: prKey,
          type: 'pr_inaccessible',
          severity: severityFor('pr_inaccessible', config),
          summary: `PR is no longer accessible (HTTP ${error.status}); it may have been deleted or access was revoked. Reminders stopped.`,
          url: existing.url,
          actor: null,
          occurred_at: now.toISOString(),
          historical: baselineMode ? 1 : 0,
        },
        now,
      );
      return row && !row.historical ? [row] : [];
    });
  }
}
