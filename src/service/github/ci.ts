import type { CiSnapshot } from './types';

const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

export interface CheckRunLike {
  name: string;
  status: string; // queued | in_progress | completed | waiting | requested | pending
  conclusion: string | null;
}

export interface StatusLike {
  context: string;
  state: string; // error | failure | pending | success
}

/** Combines check runs and legacy commit statuses into a single CI state. */
export function combineCiState(checkRuns: CheckRunLike[], statuses: StatusLike[]): CiSnapshot {
  const failing: string[] = [];
  let pending = false;
  let passing = false;

  for (const run of checkRuns) {
    if (run.status !== 'completed') {
      pending = true;
    } else if (run.conclusion && FAILING_CONCLUSIONS.has(run.conclusion)) {
      failing.push(run.name);
    } else if (run.conclusion && PASSING_CONCLUSIONS.has(run.conclusion)) {
      passing = true;
    }
  }
  for (const status of statuses) {
    if (status.state === 'failure' || status.state === 'error') {
      failing.push(status.context);
    } else if (status.state === 'pending') {
      pending = true;
    } else if (status.state === 'success') {
      passing = true;
    }
  }

  if (failing.length > 0) {
    return { state: 'failure', failing };
  }
  if (pending) {
    return { state: 'pending', failing };
  }
  return { state: passing ? 'success' : 'none', failing };
}
