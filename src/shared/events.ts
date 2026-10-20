/** Event types produced by the service when it observes PR activity. */
export const EVENT_TYPES = [
  'pr_opened',
  'pr_reopened',
  'pr_merged',
  'pr_closed',
  'pr_inaccessible',
  'branch_deleted',
  'title_changed',
  'body_changed',
  'labels_changed',
  'assignees_changed',
  'review_requested',
  'review_request_removed',
  'review_submitted',
  'changes_requested',
  'issue_comment',
  'review_comment',
  'reviewer_comment',
  'commit_pushed',
  'ci_failed',
  'ci_passed',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type Severity = 'high' | 'normal' | 'off';

export const DEFAULT_EVENT_SEVERITY: Record<EventType, Severity> = {
  pr_opened: 'normal',
  pr_reopened: 'normal',
  pr_merged: 'high',
  pr_closed: 'high',
  pr_inaccessible: 'high',
  branch_deleted: 'normal',
  title_changed: 'normal',
  body_changed: 'normal',
  labels_changed: 'normal',
  assignees_changed: 'normal',
  review_requested: 'normal',
  review_request_removed: 'normal',
  review_submitted: 'high',
  changes_requested: 'high',
  issue_comment: 'normal',
  review_comment: 'normal',
  reviewer_comment: 'high',
  commit_pushed: 'normal',
  ci_failed: 'high',
  ci_passed: 'normal',
};
