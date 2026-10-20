import * as vscode from 'vscode';
import type { EventDto, MessageDto, PullRequestDto, ReviewerDto, ServiceStatusDto } from '../../shared/protocol';
import { type DataModel, relativeTime } from '../model';

export type Channel = 'chat' | 'whatsapp';

type Node =
  | { kind: 'pr'; pr: PullRequestDto }
  | { kind: 'reviewer'; pr: PullRequestDto; reviewer: ReviewerDto }
  | { kind: 'info'; label: string; description?: string; icon: string; tooltip?: string; command?: vscode.Command; contextValue?: string; channel?: Channel }
  | { kind: 'event'; event: EventDto }
  | { kind: 'message'; message: MessageDto };

const CI_ICON: Record<PullRequestDto['ciState'], [string, string]> = {
  success: ['pass', 'testing.iconPassed'],
  failure: ['error', 'testing.iconFailed'],
  pending: ['loading~spin', 'charts.yellow'],
  none: ['circle-outline', 'disabledForeground'],
};

function prTooltip(pr: PullRequestDto): vscode.MarkdownString {
  // Untrusted PR text is added with appendText (escaped), and the markdown is not trusted.
  const md = new vscode.MarkdownString();
  md.appendText(`${pr.repo}#${pr.number}\n${pr.title}\n\n`);
  md.appendText(`State: ${pr.state}${pr.draft ? ' (draft)' : ''}${pr.paused ? ' — reminders paused' : ''}\n`);
  md.appendText(`CI: ${pr.ciState}\n`);
  md.appendText(`Last reviewer message: ${relativeTime(pr.lastNotifiedAt)}\n`);
  md.appendText(`Next reminder: ${relativeTime(pr.nextReminderAt)}\n`);
  return md;
}

function reviewerDescription(r: ReviewerDto): string {
  if (r.status === 'responded') {
    return `✓ ${r.reviewState?.toLowerCase().replace(/_/g, ' ') ?? 'responded'}`;
  }
  if (r.status === 'removed') {
    return 'request removed';
  }
  if (!r.mapped) {
    return '⚠ not mapped to a Chat user';
  }
  return `pending · ${r.reminderCount} sent · last ${relativeTime(r.lastNotifiedAt)} · next ${relativeTime(r.nextReminderAt)}`;
}

export class PullRequestTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly model: DataModel) {
    model.onDidChange(() => this.emitter.fire(undefined));
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const prs = this.model.filteredPrs();
      const order = { open: 0, inaccessible: 1, merged: 2, closed: 3 } as const;
      const sorted = [...prs].sort((a, b) => order[a.state] - order[b.state] || b.updatedAt.localeCompare(a.updatedAt));
      if (sorted.length === 0) {
        return [{ kind: 'info', label: this.model.prs.length ? 'No pull requests match the filter' : 'No pull requests found yet', icon: 'info' }];
      }
      return sorted.map((pr) => ({ kind: 'pr', pr }));
    }
    if (node.kind === 'pr') {
      const { pr } = node;
      const [ciIcon] = CI_ICON[pr.ciState];
      return [
        ...pr.reviewers.map((reviewer): Node => ({ kind: 'reviewer', pr, reviewer })),
        { kind: 'info', label: 'CI / checks', description: pr.ciState, icon: ciIcon },
        { kind: 'info', label: 'Last reviewer DM', description: relativeTime(pr.lastNotifiedAt), icon: 'comment-discussion' },
        { kind: 'info', label: 'Next reminder', description: pr.paused ? 'paused' : relativeTime(pr.nextReminderAt), icon: 'clock' },
      ];
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'pr': {
        const { pr } = node;
        const pending = pr.reviewers.filter((r) => r.status === 'pending').length;
        const item = new vscode.TreeItem(`#${pr.number} ${pr.title}`, vscode.TreeItemCollapsibleState.Collapsed);
        const reviewState =
          pending > 0 ? `${pending} pending` : pr.reviewers.some((r) => r.status === 'responded') ? 'reviewed · re-request to remind again' : 'no reviewers requested';
        item.description = `${pr.repo} · ${pr.state === 'open' ? reviewState : pr.state}${pr.paused ? ' · paused' : ''}`;
        const [icon, color] = pr.state === 'open' ? CI_ICON[pr.ciState] : pr.state === 'merged' ? ['git-merge', 'charts.purple'] : ['git-pull-request-closed', 'charts.red'];
        item.iconPath = new vscode.ThemeIcon(pr.state === 'open' && pr.ciState === 'none' ? 'git-pull-request' : icon, new vscode.ThemeColor(color));
        item.tooltip = prTooltip(pr);
        item.contextValue = pr.paused ? 'pr-paused' : 'pr-active';
        item.command = { command: 'prReminder.openSelectedPr', title: 'Open PR', arguments: [pr] };
        item.id = pr.key;
        return item;
      }
      case 'reviewer': {
        const { reviewer } = node;
        const item = new vscode.TreeItem(`${reviewer.kind === 'team' ? '' : '@'}${reviewer.login}`);
        item.description = reviewerDescription(reviewer);
        item.iconPath = new vscode.ThemeIcon(
          reviewer.status === 'responded' ? 'pass-filled' : reviewer.mapped || reviewer.status !== 'pending' ? (reviewer.kind === 'team' ? 'organization' : 'person') : 'warning',
          reviewer.status === 'pending' && !reviewer.mapped ? new vscode.ThemeColor('list.warningForeground') : undefined,
        );
        const channels = [
          reviewer.maskedEmail ? `Google Chat: ${reviewer.maskedEmail}` : null,
          reviewer.maskedPhone ? `WhatsApp: ${reviewer.maskedPhone}` : null,
        ].filter(Boolean);
        item.tooltip = channels.length ? `Messages go to\n${channels.join('\n')}` : 'Not mapped: add a Workspace email or WhatsApp number in the dashboard.';
        return item;
      }
      case 'info': {
        const item = new vscode.TreeItem(node.label);
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.tooltip = node.tooltip;
        item.command = node.command;
        return item;
      }
      case 'event':
        return eventItem(node.event);
      case 'message':
        return messageItem(node.message, null);
    }
  }
}

function eventItem(event: EventDto): vscode.TreeItem {
  const item = new vscode.TreeItem(`${event.repo}#${event.number}: ${event.summary}`);
  item.description = `${relativeTime(event.recordedAt)}${event.acknowledged ? '' : ' • new'}`;
  item.iconPath = new vscode.ThemeIcon(
    event.severity === 'high' ? 'flame' : 'bell',
    event.acknowledged ? undefined : new vscode.ThemeColor(event.severity === 'high' ? 'charts.red' : 'charts.blue'),
  );
  const md = new vscode.MarkdownString();
  md.appendText(`${event.type} (${event.severity})\n${event.prTitle}\n${event.summary}`);
  item.tooltip = md;
  item.command = { command: 'prReminder.openSelectedPr', title: 'Open', arguments: [{ url: event.url }] };
  return item;
}

const MESSAGE_STATUS: Record<MessageDto['status'], { icon: string; color?: string; label: string }> = {
  queued: { icon: 'clock', color: 'charts.yellow', label: 'waiting' },
  sending: { icon: 'loading~spin', color: 'charts.blue', label: 'sending' },
  sent: { icon: 'pass-filled', color: 'testing.iconPassed', label: 'sent' },
  failed: { icon: 'error', color: 'testing.iconFailed', label: 'failed' },
  cancelled: { icon: 'circle-slash', label: 'cancelled' },
};

function messageItem(m: MessageDto, whatsappActivity: string | null): vscode.TreeItem {
  const st = MESSAGE_STATUS[m.status];
  const channel = m.channel === 'whatsapp' ? 'WhatsApp' : 'Google Chat';
  const item = new vscode.TreeItem(`@${m.reviewer} · ${m.prKey}`);
  let when: string;
  if (m.status === 'sent') {
    when = relativeTime(m.sentAt);
  } else if (m.status === 'queued') {
    const due = Date.parse(m.nextAttemptAt) <= Date.now() ? 'next in line' : relativeTime(m.nextAttemptAt);
    when = m.attempts > 0 ? `retry ${due}` : due;
  } else if (m.status === 'sending' && m.channel === 'whatsapp' && whatsappActivity) {
    when = whatsappActivity;
  } else {
    when = relativeTime(m.createdAt);
  }
  item.description = `${channel} · ${st.label} · ${when}`;
  item.iconPath = new vscode.ThemeIcon(st.icon, st.color ? new vscode.ThemeColor(st.color) : undefined);
  const md = new vscode.MarkdownString();
  md.appendText(
    [
      `${m.kind === 'initial' ? 'Review request' : 'Reminder'} to @${m.reviewer} via ${channel} (${m.recipient})`,
      `PR: ${m.prKey}`,
      `Status: ${st.label}${m.attempts ? ` · ${m.attempts} attempt(s)` : ''}`,
      `Created: ${relativeTime(m.createdAt)}`,
      m.sentAt ? `Sent: ${relativeTime(m.sentAt)}` : null,
      m.lastError ? `\nLast error: ${m.lastError}` : null,
      m.status === 'failed' ? '\nRight-click → Retry, or use the retry button in the view title.' : null,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  item.tooltip = md;
  item.contextValue = `message-${m.status}`;
  return item;
}

/** Reviewer messages (Google Chat and WhatsApp) with their delivery status, newest first. */
export class MessagesTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly model: DataModel) {
    model.onDidChange(() => this.emitter.fire(undefined));
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (node) {
      return [];
    }
    const nodes: Node[] = [];
    const activity = this.model.status?.whatsappActivity;
    if (activity) {
      nodes.push({ kind: 'info', label: 'WhatsApp', description: activity, icon: 'loading~spin' });
    }
    if (this.model.messages.length === 0) {
      nodes.push({ kind: 'info', label: 'No reviewer messages yet', icon: 'info' });
    }
    return [...nodes, ...this.model.messages.map((message): Node => ({ kind: 'message', message }))];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'message') {
      return messageItem(node.message, this.model.status?.whatsappActivity ?? null);
    }
    const item = new vscode.TreeItem(node.kind === 'info' ? node.label : '');
    if (node.kind === 'info') {
      item.description = node.description;
      item.iconPath = new vscode.ThemeIcon(node.icon);
    }
    return item;
  }
}

export class ActivityTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly model: DataModel) {
    model.onDidChange(() => this.emitter.fire(undefined));
  }

  getChildren(node?: Node): Node[] {
    if (node) {
      return [];
    }
    if (this.model.events.length === 0) {
      return [{ kind: 'info', label: 'No activity since monitoring started', icon: 'info' }];
    }
    return this.model.events.slice(0, 50).map((event) => ({ kind: 'event', event }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'event') {
      return eventItem(node.event);
    }
    const item = new vscode.TreeItem(node.kind === 'info' ? node.label : '');
    item.iconPath = new vscode.ThemeIcon('info');
    return item;
  }
}

/** Shows that tracking is account-wide (or which repositories are configured), not tied to the open folder. */
function trackingNode(prs: PullRequestDto[]): Node {
  const configured = vscode.workspace.getConfiguration('prReminder').get<string[]>('github.repositories', []);
  const withOpenPrs = [...new Set(prs.filter((p) => p.state === 'open').map((p) => p.repo))].sort();
  const tooltip = withOpenPrs.length ? `Repositories with open PRs:\n${withOpenPrs.join('\n')}` : undefined;
  return configured.length === 0
    ? { kind: 'info', label: 'Tracking', description: `all repositories · ${withOpenPrs.length} with open PRs`, icon: 'globe', tooltip }
    : { kind: 'info', label: 'Tracking', description: `${configured.length} selected repositories`, icon: 'repo', tooltip: configured.join('\n') };
}

/** One row per reviewer-message channel, with an inline on/off switch (contextValue channel-<id>-on|off). */
function channelNodes(s: ServiceStatusDto): Node[] {
  const settings = vscode.workspace.getConfiguration('prReminder');
  const chatOn = settings.get<boolean>('chat.enabled', true);
  const waOn = settings.get<boolean>('whatsapp.enabled', false);
  const chatReady = s.chatConfigured;
  const waReady = s.whatsappLinked && !s.whatsappError;
  return [
    {
      kind: 'info',
      label: 'Google Chat',
      channel: 'chat',
      contextValue: `channel-chat-${chatOn ? 'on' : 'off'}`,
      description: chatOn ? (chatReady ? 'ON · signed in' : 'ON · not signed in') : 'OFF',
      icon: chatOn && !chatReady ? 'warning' : chatOn ? 'comment-discussion' : 'circle-slash',
      tooltip: `${chatOn ? 'Reviewers get Google Chat DMs.' : 'Google Chat messages are off.'} Click to test, sign in again, switch account or change the OAuth client.`,
      command: { command: 'prReminder.manageGoogleChat', title: 'Google Chat' },
    },
    {
      kind: 'info',
      label: 'WhatsApp',
      channel: 'whatsapp',
      contextValue: `channel-whatsapp-${waOn ? 'on' : 'off'}`,
      description: waOn ? (waReady ? 'ON · linked' : 'ON · not linked') : s.whatsappLinked ? 'OFF · linked' : 'OFF',
      icon: waOn && !waReady ? 'warning' : waOn ? 'device-mobile' : 'circle-slash',
      tooltip: s.whatsappError ?? `${waOn ? 'Reviewers get WhatsApp messages.' : 'WhatsApp messages are off.'} Click to test, re-link or unlink.`,
      command: { command: 'prReminder.manageWhatsApp', title: 'WhatsApp' },
    },
  ];
}

export class StatusTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly model: DataModel,
    private readonly connection: () => { state: string; error: string | null },
  ) {
    model.onDidChange(() => this.emitter.fire(undefined));
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (node) {
      return [];
    }
    const conn = this.connection();
    const s = this.model.status;
    const nodes: Node[] = [
      {
        kind: 'info',
        label: 'Notification service',
        description: conn.state === 'connected' ? `connected (v${s?.version ?? '?'})` : conn.state,
        icon: conn.state === 'connected' ? 'pass' : 'error',
        tooltip: conn.error ?? undefined,
        command: conn.state === 'connected' ? undefined : { command: 'prReminder.restartService', title: 'Restart' },
      },
    ];
    if (s) {
      nodes.push(
        { kind: 'info', label: 'GitHub', description: s.githubConfigured ? `@${s.githubUser ?? '?'}` : 'not configured', icon: s.githubConfigured ? 'github' : 'warning', command: s.githubConfigured ? undefined : { command: 'prReminder.setup', title: 'Setup' } },
        trackingNode(this.model.prs),
        ...channelNodes(s),
        { kind: 'info', label: 'Reminders', description: s.globalPaused ? 'PAUSED' : 'active', icon: s.globalPaused ? 'debug-pause' : 'play' },
        { kind: 'info', label: 'Last sync', description: relativeTime(s.lastSyncAt), icon: 'sync', tooltip: s.lastSyncError ?? undefined },
        { kind: 'info', label: 'GitHub API quota', description: s.rateLimit.remaining !== null ? `${s.rateLimit.remaining}/${s.rateLimit.limit}` : 'unknown', icon: 'dashboard' },
      );
      if (s.lastSyncError) {
        nodes.push({ kind: 'info', label: 'Sync error', description: s.lastSyncError, icon: 'error', tooltip: s.lastSyncError });
      }
      if (s.failedMessages > 0) {
        nodes.push({ kind: 'info', label: `${s.failedMessages} failed reviewer message(s)`, description: 'click to retry', icon: 'warning', command: { command: 'prReminder.retryMessages', title: 'Retry' } });
      }
    }
    for (const u of this.model.unmapped) {
      nodes.push({
        kind: 'info',
        label: `Unmapped reviewer: ${u.kind === 'team' ? '' : '@'}${u.login}`,
        description: u.prKeys.join(', '),
        icon: 'warning',
        tooltip: 'This reviewer gets no messages until you add their Workspace email or WhatsApp number.',
        command: { command: 'prReminder.openDashboard', title: 'Map reviewer', arguments: ['mapping'] },
      });
    }
    return nodes;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind !== 'info') {
      return new vscode.TreeItem('');
    }
    const item = new vscode.TreeItem(node.label);
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon(node.icon, node.icon === 'warning' || node.icon === 'error' ? new vscode.ThemeColor('list.warningForeground') : undefined);
    item.tooltip = node.tooltip;
    item.command = node.command;
    item.contextValue = node.contextValue;
    return item;
  }
}
