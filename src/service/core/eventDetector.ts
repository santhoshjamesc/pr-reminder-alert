import { DEFAULT_EVENT_SEVERITY, type EventType, type Severity } from '../../shared/events';
import type { AppConfig } from '../config/schema';
import type { CommentSnapshot, PrSnapshot } from '../github/types';
import { prKeyOf } from '../github/types';
import type { NewEvent } from '../storage/eventRepository';
import type { PrRow } from '../storage/prRepository';
import { shortHash } from './hash';

export interface DetectionContext {
  config: AppConfig;
  /** Logins (lower-case) that have ever been requested as reviewers on this PR. */
  reviewerLogins: Set<string>;
  /** Event belongs to the initial baseline (or a PR that pre-dates monitoring). */
  historical: boolean;
}

export function severityFor(type: EventType, config: AppConfig): Severity {
  return config.alerts.severity[type] ?? DEFAULT_EVENT_SEVERITY[type];
}

function snippet(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function isImportantComment(comment: CommentSnapshot, ctx: DetectionContext): boolean {
  if (!ctx.reviewerLogins.has(comment.user.toLowerCase())) {
    return false;
  }
  const keywords = ctx.config.alerts.importantCommentKeywords;
  if (keywords.length === 0) {
    return true;
  }
  const body = comment.body.toLowerCase();
  return keywords.some((k) => body.includes(k.toLowerCase()));
}

/**
 * Compares the previously stored PR row with a fresh GitHub snapshot and
 * returns every activity event. Each event has a deterministic unique key so
 * re-detecting the same activity (after a restart, or on the next poll) is a
 * no-op at insert time.
 */
export function detectEvents(prev: PrRow | undefined, snap: PrSnapshot, ctx: DetectionContext): NewEvent[] {
  const prKey = prKeyOf(snap);
  const author = snap.author.toLowerCase();
  const events: NewEvent[] = [];
  const add = (type: EventType, key: string, summary: string, url: string, actor: string | null, occurredAt: string | null, historical = ctx.historical) => {
    events.push({
      event_key: `${type}:${key}`,
      pr_key: prKey,
      type,
      severity: severityFor(type, ctx.config),
      summary,
      url,
      actor,
      occurred_at: occurredAt ?? snap.updatedAt,
      historical: historical ? 1 : 0,
    });
  };

  const newPr = prev === undefined;
  const nowState = snap.merged ? 'merged' : snap.state;

  if (newPr) {
    add('pr_opened', prKey, `Pull request opened: ${snippet(snap.title)}`, snap.url, snap.author, snap.createdAt);
  } else {
    const prevState = prev.state;
    if (prevState !== 'merged' && nowState === 'merged') {
      add('pr_merged', prKey, 'Pull request merged', snap.url, null, snap.mergedAt);
    } else if (prevState !== 'closed' && prevState !== 'merged' && nowState === 'closed') {
      add('pr_closed', `${prKey}:${snap.closedAt ?? snap.updatedAt}`, 'Pull request closed without merging', snap.url, null, snap.closedAt);
    } else if ((prevState === 'closed' || prevState === 'inaccessible') && nowState === 'open') {
      add('pr_reopened', `${prKey}:${snap.updatedAt}`, 'Pull request reopened', snap.url, null, snap.updatedAt);
    }
    if (prev.title !== snap.title) {
      add('title_changed', `${prKey}:${shortHash(snap.title)}:${snap.updatedAt}`, `Title changed to "${snippet(snap.title)}"`, snap.url, null, snap.updatedAt);
    }
    if (prev.body_hash !== shortHash(snap.body)) {
      add('body_changed', `${prKey}:${shortHash(snap.body)}:${snap.updatedAt}`, 'Description updated', snap.url, null, snap.updatedAt);
    }
    const labels = JSON.stringify([...snap.labels].sort());
    if (prev.labels !== labels) {
      add('labels_changed', `${prKey}:${shortHash(labels)}:${snap.updatedAt}`, `Labels: ${snap.labels.join(', ') || 'none'}`, snap.url, null, snap.updatedAt);
    }
    const assignees = JSON.stringify([...snap.assignees].sort());
    if (prev.assignees !== assignees) {
      add(
        'assignees_changed',
        `${prKey}:${shortHash(assignees)}:${snap.updatedAt}`,
        `Assignees: ${snap.assignees.map((a) => `@${a}`).join(', ') || 'none'}`,
        snap.url,
        null,
        snap.updatedAt,
      );
    }
    if (!prev.branch_deleted && snap.headRepoMissing) {
      add('branch_deleted', `${prKey}:${snap.headRef}`, `Head branch ${snap.headRef} was deleted`, snap.url, null, snap.updatedAt);
    }
  }

  for (const review of snap.reviews) {
    if (review.state === 'PENDING' || review.user.toLowerCase() === author) {
      continue;
    }
    const type: EventType = review.state === 'CHANGES_REQUESTED' ? 'changes_requested' : 'review_submitted';
    const verb =
      review.state === 'APPROVED'
        ? 'approved'
        : review.state === 'CHANGES_REQUESTED'
          ? 'requested changes'
          : review.state === 'DISMISSED'
            ? 'review dismissed'
            : 'reviewed (comment)';
    add(type, String(review.id), `@${review.user} ${verb}`, review.url || snap.url, review.user, review.submittedAt);
  }

  for (const comment of snap.issueComments) {
    if (comment.user.toLowerCase() === author) {
      continue;
    }
    const important = isImportantComment(comment, ctx);
    add(
      important ? 'reviewer_comment' : 'issue_comment',
      `issue:${comment.id}`,
      `@${comment.user} commented: ${snippet(comment.body)}`,
      comment.url,
      comment.user,
      comment.createdAt,
    );
  }

  for (const comment of snap.reviewComments) {
    if (comment.user.toLowerCase() === author) {
      continue;
    }
    const important = isImportantComment(comment, ctx);
    add(
      important ? 'reviewer_comment' : 'review_comment',
      `review:${comment.id}`,
      `@${comment.user} commented on ${comment.path ?? 'the diff'}: ${snippet(comment.body)}`,
      comment.url,
      comment.user,
      comment.createdAt,
    );
  }

  // Commits present when a PR first appears are part of "opened", not new pushes.
  const knownHead = prev?.head_sha;
  for (const commit of snap.commits) {
    add(
      'commit_pushed',
      `${prKey}:${commit.sha}`,
      `New commit ${commit.sha.slice(0, 7)}: ${snippet(commit.message, 100)}`,
      `${snap.url}/commits/${commit.sha}`,
      commit.author,
      commit.date,
      ctx.historical || newPr || knownHead === undefined,
    );
  }

  const prevCi = prev && prev.head_sha === snap.headSha ? prev.ci_state : 'none';
  if (snap.ci.state !== prevCi) {
    if (snap.ci.state === 'failure') {
      const names = snap.ci.failing.slice(0, 3).join(', ');
      add('ci_failed', `${prKey}:${snap.headSha}`, `CI failed${names ? `: ${names}` : ''}`, `${snap.url}/checks`, null, snap.updatedAt);
    } else if (snap.ci.state === 'success') {
      add('ci_passed', `${prKey}:${snap.headSha}`, 'CI passed', `${snap.url}/checks`, null, snap.updatedAt);
    }
  }

  return events;
}
