import * as vscode from 'vscode';
import type { DeliveryFailureDto, EventDto, MessageDto, PullRequestDto, ServiceStatusDto, UnmappedReviewerDto } from '../shared/protocol';
import type { ApiClient } from './service/apiClient';

export interface PrFilter {
  repo?: string;
  state?: PullRequestDto['state'] | 'needs-review';
  reviewer?: string;
}

/** Latest snapshot of service data shared by the tree views, dashboard and status bar. */
export class DataModel implements vscode.Disposable {
  status: ServiceStatusDto | null = null;
  prs: PullRequestDto[] = [];
  events: EventDto[] = [];
  unmapped: UnmappedReviewerDto[] = [];
  failedMessages: DeliveryFailureDto[] = [];
  messages: MessageDto[] = [];
  lastError: string | null = null;
  filter: PrFilter = {};
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly memento: vscode.Memento) {
    this.filter = memento.get<PrFilter>('prReminder.filter', {});
  }

  async refresh(api: ApiClient): Promise<void> {
    const [status, prs, events, unmapped, failed, messages] = await Promise.all([
      api.status(),
      api.pullRequests(),
      api.events(0, 100),
      api.unmapped(),
      api.failedMessages(),
      api.messages(),
    ]);
    this.status = status;
    this.prs = prs;
    this.events = events;
    this.unmapped = unmapped;
    this.failedMessages = failed;
    this.messages = messages;
    this.lastError = null;
    void vscode.commands.executeCommand('setContext', 'prReminder.globalPaused', status.globalPaused);
    this.emitter.fire();
  }

  /** Messages are waiting or being sent, so the views should refresh more often. */
  hasActiveMessages(): boolean {
    return Boolean(this.status?.whatsappActivity) || this.messages.some((m) => m.status === 'queued' || m.status === 'sending');
  }

  setError(message: string | null): void {
    this.lastError = message;
    this.emitter.fire();
  }

  setFilter(filter: PrFilter): void {
    this.filter = filter;
    void this.memento.update('prReminder.filter', filter);
    void vscode.commands.executeCommand('setContext', 'prReminder.filtered', Object.keys(filter).length > 0);
    this.emitter.fire();
  }

  filteredPrs(): PullRequestDto[] {
    const { repo, state, reviewer } = this.filter;
    return this.prs.filter((pr) => {
      if (repo && pr.repo !== repo) {
        return false;
      }
      if (state === 'needs-review') {
        if (pr.state !== 'open' || !pr.reviewers.some((r) => r.status === 'pending')) {
          return false;
        }
      } else if (state && pr.state !== state) {
        return false;
      }
      if (reviewer && !pr.reviewers.some((r) => r.login.toLowerCase() === reviewer.toLowerCase())) {
        return false;
      }
      return true;
    });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) {
    return '—';
  }
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  const text = mins < 1 ? 'now' : mins < 60 ? `${mins}m` : mins < 48 * 60 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  if (text === 'now') {
    return 'now';
  }
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}
