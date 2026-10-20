import * as vscode from 'vscode';
import type { EventType } from '../../shared/events';
import type { EventDto } from '../../shared/protocol';
import { isAllowedPrUrl } from '../configBuilder';
import { type AlertDecision, type AlertSettings, type AlertStyle, AlertState } from './alertPolicy';
import { EditorBanner } from './banner';
import { BigAlertOverlay } from './bigAlert';
import { playAlertSound } from './sound';

const SNOOZE_CHOICES: Array<{ label: string; minutes: number }> = [
  { label: '15 minutes', minutes: 15 },
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: 'Until tomorrow (12 hours)', minutes: 720 },
];

export function readAlertSettings(): AlertSettings {
  const c = vscode.workspace.getConfiguration('prReminder.alerts');
  return {
    highStyles: c.get<AlertStyle[]>('highPriorityStyles', ['notification', 'banner', 'statusBar']),
    normalStyles: c.get<AlertStyle[]>('normalPriorityStyles', ['notification', 'statusBar']),
    soundEnabled: c.get<boolean>('soundEnabled', false),
    quietMode: c.get<boolean>('quietMode', false),
    repeatTypes: c.get<EventType[]>('repeatUntilAcknowledged', []),
    repeatIntervalMs: Math.max(30, c.get<number>('repeatIntervalSeconds', 300)) * 1000,
  };
}

/** Id of the sample event shown by "Preview Big Alert"; it is never sent to the service. */
const PREVIEW_EVENT_ID = 2_147_483_647;

const DEFAULT_BIG_EVENTS: EventType[] = ['pr_merged', 'pr_closed', 'changes_requested', 'review_submitted', 'reviewer_comment', 'issue_comment', 'review_comment'];

/** Whether an event should use the full-screen overlay ("big" alert size). Quiet mode and snooze leave only the status bar, which never goes big. */
function wantsBig(decision: AlertDecision): boolean {
  const c = vscode.workspace.getConfiguration('prReminder.alerts');
  return (
    c.get<string>('size', 'normal') === 'big' &&
    c.get<EventType[]>('bigAlertEvents', DEFAULT_BIG_EVENTS).includes(decision.event.type) &&
    decision.styles.some((s) => s !== 'statusBar')
  );
}

/**
 * Presents PR events using the configured alert styles: notifications,
 * an in-editor banner, an optional sound and a status bar counter. Only the
 * opt-in "big" alert size takes focus, with a full black overlay in the editor.
 */
export class AlertManager implements vscode.Disposable {
  readonly state: AlertState;
  private readonly banner = new EditorBanner();
  private readonly overlay: BigAlertOverlay;
  private readonly statusItem: vscode.StatusBarItem;
  private repeatTimer: NodeJS.Timeout | null = null;
  private connection: 'connected' | 'disconnected' | 'starting' = 'starting';
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly acknowledgeRemote: (ids: number[] | 'all') => Promise<void>,
    private readonly output: vscode.OutputChannel,
    private readonly apiBaseUrl: () => string,
    extensionUri: vscode.Uri,
  ) {
    this.state = new AlertState(readAlertSettings());
    this.overlay = new BigAlertOverlay(extensionUri, {
      open: (event) => this.openUrl(event.url),
      acknowledge: (ids) => this.acknowledge(ids),
      snooze: () => this.promptSnooze(),
    });
    this.statusItem = vscode.window.createStatusBarItem('prReminder.alerts', vscode.StatusBarAlignment.Left, 1000);
    this.statusItem.name = 'PR Reminder Alerts';
    this.statusItem.command = 'prReminder.openDashboard';
    this.statusItem.show();
    this.repeatTimer = setInterval(() => this.runRepeats(), 15_000);
    this.render();
  }

  reloadSettings(): void {
    this.state.updateSettings(readAlertSettings());
    this.render();
  }

  setConnection(state: 'connected' | 'disconnected' | 'starting'): void {
    this.connection = state;
    this.render();
  }

  /** Drops alerts that were acknowledged elsewhere (another VS Code window or the API). */
  syncAcknowledged(events: EventDto[]): void {
    const acked = events.filter((e) => e.acknowledged).map((e) => e.id);
    this.overlay.forget(acked);
    if (this.state.acknowledge(acked).length > 0) {
      if (this.state.unacknowledgedCount() === 0) {
        this.banner.hide();
      }
      this.render();
      this.changeEmitter.fire();
    }
  }

  /** Handles events fetched from the service. `quietIngest` adds them without pop-ups (e.g. on startup). */
  handle(events: EventDto[], quietIngest = false): void {
    const decisions = this.state.ingest(events, Date.now());
    if (decisions.length === 0) {
      return;
    }
    if (quietIngest) {
      void vscode.window
        .showInformationMessage(`PR Reminder: ${decisions.length} unacknowledged PR alert(s) while you were away.`, 'Open Dashboard', 'Acknowledge All')
        .then((choice) => this.onSummaryChoice(choice));
    } else if (decisions.length > 3) {
      this.presentSummary(decisions);
    } else {
      for (const decision of decisions) {
        this.present(decision);
      }
    }
    this.render();
    this.changeEmitter.fire();
  }

  private presentSummary(decisions: AlertDecision[]): void {
    const big = decisions.filter(wantsBig);
    if (big.length) {
      this.overlay.show(big.map((d) => d.event));
      decisions = decisions.filter((d) => !big.includes(d));
      if (decisions.length === 0) {
        this.playSoundFor(big);
        return;
      }
    }
    const styles = new Set(decisions.flatMap((d) => d.styles));
    const high = decisions.filter((d) => d.event.severity === 'high').length;
    const text = `PR Reminder: ${decisions.length} new PR events${high ? ` (${high} high priority)` : ''}`;
    if (styles.has('notification')) {
      const show = high ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      void show(text, 'Open Dashboard', 'Acknowledge All').then((choice) => this.onSummaryChoice(choice));
    }
    if (styles.has('banner')) {
      this.showBanner(text);
    }
    if (styles.has('sound')) {
      this.playSound();
    }
  }

  private onSummaryChoice(choice: string | undefined): void {
    if (choice === 'Open Dashboard') {
      void vscode.commands.executeCommand('prReminder.openDashboard');
    } else if (choice === 'Acknowledge All') {
      void this.acknowledge('all');
    }
  }

  private present(decision: AlertDecision): void {
    const { event, styles } = decision;
    if (wantsBig(decision)) {
      this.overlay.show([event]);
      this.playSoundFor([decision]);
      return;
    }
    const text = `${event.repo}#${event.number} ${event.prTitle ? `“${truncate(event.prTitle, 60)}” — ` : ''}${truncate(event.summary, 120)}`;
    if (styles.includes('notification')) {
      const show = event.severity === 'high' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      void show(`PR Reminder: ${text}`, 'Open', 'Acknowledge', 'Snooze').then((choice) => {
        if (choice === 'Open') {
          this.openUrl(event.url);
          void this.acknowledge([event.id]);
        } else if (choice === 'Acknowledge') {
          void this.acknowledge([event.id]);
        } else if (choice === 'Snooze') {
          void this.promptSnooze();
        }
      });
    }
    if (styles.includes('banner')) {
      this.showBanner(text);
    }
    if (styles.includes('sound')) {
      this.playSound();
    }
  }

  private showBanner(text: string): void {
    const c = vscode.workspace.getConfiguration('prReminder.alerts');
    this.banner.show(`PR ALERT: ${text} — acknowledge with “PR Reminder: Acknowledge All Alerts”`, {
      flash: c.get<boolean>('flashBanner', true),
      hideAfterMs: c.get<number>('bannerSeconds', 0) * 1000,
    });
  }

  private playSoundFor(decisions: AlertDecision[]): void {
    if (decisions.some((d) => d.styles.includes('sound'))) {
      this.playSound();
    }
  }

  private playSound(): void {
    playAlertSound(vscode.workspace.getConfiguration('prReminder.alerts').get<string>('soundFile', ''), (m) => this.output.appendLine(`[alerts] ${m}`));
  }

  private runRepeats(): void {
    for (const decision of this.state.dueRepeats(Date.now())) {
      this.present(decision);
    }
    this.render();
  }

  openUrl(url: string): void {
    if (isAllowedPrUrl(url, this.apiBaseUrl())) {
      void vscode.env.openExternal(vscode.Uri.parse(url));
    } else {
      this.output.appendLine(`[alerts] Refused to open non-GitHub URL`);
    }
  }

  /** Shows a sample normal alert (notification, banner and status bar style) regardless of the alert size setting. */
  previewNormal(): void {
    const text = 'example/repo#42 “Preview: Add rate limiting to public endpoints” — This is a preview of a normal alert.';
    void vscode.window.showWarningMessage(`PR Reminder: ${text}`, 'Open Dashboard').then((choice) => this.onSummaryChoice(choice));
    // The sample banner clears itself; real banners stay until acknowledged.
    this.banner.show(`PR ALERT: ${text}`, { flash: vscode.workspace.getConfiguration('prReminder.alerts').get<boolean>('flashBanner', true), hideAfterMs: 30_000 });
  }

  /** Shows the big overlay with a sample event so the user can see what it looks like. */
  previewBig(): void {
    const now = new Date().toISOString();
    this.overlay.show([
      {
        id: PREVIEW_EVENT_ID,
        key: 'preview',
        prKey: 'example/repo#42',
        repo: 'example/repo',
        number: 42,
        prTitle: 'Preview: Add rate limiting to public endpoints',
        type: 'pr_merged',
        severity: 'high',
        summary: 'This is a preview of the big alert. Real alerts say what happened (merged, commented, changes requested…) on which PR.',
        url: '',
        actor: 'reviewer',
        occurredAt: now,
        recordedAt: now,
        historical: false,
        acknowledged: false,
      },
    ]);
  }

  /** Marks alerts as seen locally and in the service. Does not affect GitHub reviews. */
  async acknowledge(ids: number[] | 'all'): Promise<void> {
    if (ids !== 'all' && ids.every((id) => id === PREVIEW_EVENT_ID)) {
      this.overlay.forget(ids);
      return;
    }
    const removed = this.state.acknowledge(ids);
    this.overlay.forget(ids);
    if (this.state.unacknowledgedCount() === 0) {
      this.banner.hide();
    }
    this.render();
    this.changeEmitter.fire();
    try {
      await this.acknowledgeRemote(ids === 'all' ? 'all' : removed.length ? removed : ids);
    } catch (error) {
      this.output.appendLine(`[alerts] Failed to record acknowledgement: ${(error as Error).message}`);
    }
  }

  async promptSnooze(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      [...SNOOZE_CHOICES.map((c) => ({ label: c.label, minutes: c.minutes })), ...(this.state.snoozeUntil() ? [{ label: 'Cancel snooze', minutes: 0 }] : [])],
      { placeHolder: 'Snooze PR alerts (status bar counter stays visible)' },
    );
    if (!pick) {
      return;
    }
    if (pick.minutes === 0) {
      this.state.clearSnooze();
    } else {
      this.state.snooze(pick.minutes * 60_000, Date.now());
      this.banner.hide();
      this.overlay.hide();
    }
    this.render();
    this.changeEmitter.fire();
  }

  private render(): void {
    const count = this.state.unacknowledgedCount();
    const snoozed = this.state.isSnoozed(Date.now());
    const quiet = readAlertSettings().quietMode;
    if (this.connection !== 'connected') {
      this.statusItem.text = this.connection === 'starting' ? '$(sync~spin) PR Reminder' : '$(debug-disconnect) PR Reminder';
      this.statusItem.tooltip = 'PR Reminder: notification service not connected. Click to open the dashboard.';
      this.statusItem.backgroundColor = this.connection === 'disconnected' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      return;
    }
    const icon = snoozed || quiet ? '$(bell-slash)' : count > 0 ? '$(bell-dot)' : '$(bell)';
    this.statusItem.text = count > 0 ? `${icon} ${count} PR alert${count === 1 ? '' : 's'}` : `${icon} PR`;
    this.statusItem.backgroundColor =
      count > 0 ? new vscode.ThemeColor(this.state.hasHighPriority() ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground') : undefined;
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**PR Reminder**\n\n');
    for (const e of this.state.unacknowledged().slice(0, 8)) {
      md.appendText(`• ${e.severity === 'high' ? '[!] ' : ''}${e.repo}#${e.number}: ${truncate(e.summary, 80)}\n`);
    }
    if (count === 0) {
      md.appendText('No unacknowledged alerts.\n');
    }
    if (snoozed) {
      md.appendText(`\nSnoozed until ${new Date(this.state.snoozeUntil() ?? 0).toLocaleTimeString()}`);
    }
    if (quiet) {
      md.appendText('\nQuiet mode is on.');
    }
    this.statusItem.tooltip = md;
  }

  dispose(): void {
    if (this.repeatTimer) {
      clearInterval(this.repeatTimer);
    }
    this.banner.dispose();
    this.overlay.dispose();
    this.statusItem.dispose();
    this.changeEmitter.dispose();
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
