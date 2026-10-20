import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { z } from 'zod';
import { phoneNumber, reviewerKey } from '../../service/config/schema';
import type { AlertManager } from '../alerts/alertManager';
import type { DataModel } from '../model';

const inbound = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('refresh') }),
  z.object({ type: z.literal('openUrl'), url: z.string().max(2000) }),
  z.object({ type: z.literal('ack'), ids: z.union([z.literal('all'), z.array(z.number().int().positive()).max(1000)]) }),
  z.object({ type: z.literal('snooze') }),
  z.object({ type: z.literal('pause'), prKey: z.string().max(300).optional() }),
  z.object({ type: z.literal('resume'), prKey: z.string().max(300).optional() }),
  z.object({ type: z.literal('retryMessages'), ids: z.array(z.number().int().positive()).max(1000).optional() }),
  z.object({ type: z.literal('clearMessages'), ids: z.array(z.number().int().positive()).max(1000).optional() }),
  z.object({ type: z.literal('testChat') }),
  z.object({ type: z.literal('setup') }),
  z.object({ type: z.literal('setChannel'), channel: z.enum(['chat', 'whatsapp']), enabled: z.boolean() }),
  z.object({ type: z.literal('signInGoogle') }),
  z.object({ type: z.literal('linkWhatsApp') }),
  z.object({ type: z.literal('testWhatsApp') }),
  z.object({ type: z.literal('setAlertSize'), size: z.enum(['normal', 'big']) }),
  z.object({ type: z.literal('previewBigAlert') }),
  z.object({ type: z.literal('customReminderInterval') }),
  z.object({
    type: z.literal('setReminders'),
    intervalMinutes: z.number().int().min(1).max(10080).optional(),
    maxRemindersPerReviewer: z.number().int().min(0).max(100).optional(),
  }),
  z.object({
    type: z.literal('saveMapping'),
    mapping: z.record(reviewerKey, z.email()),
    numbers: z.record(reviewerKey, phoneNumber).default({}),
  }),
]);

export interface DashboardActions {
  refresh(): Promise<void>;
  pause(prKey?: string): Promise<void>;
  resume(prKey?: string): Promise<void>;
  retryMessages(ids?: number[]): Promise<void>;
  clearMessages(ids?: number[]): Promise<void>;
  testChat(): Promise<void>;
}

/**
 * Dashboard webview. It receives only display data (no tokens or passwords);
 * reviewer emails are shown because the user maintains them here. All
 * untrusted text is rendered with textContent inside the webview and a strict
 * CSP with a per-load nonce is applied.
 */
export class DashboardPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly model: DataModel,
    private readonly alerts: AlertManager,
    private readonly actions: DashboardActions,
    private readonly connection: () => { state: string; error: string | null },
  ) {
    this.disposables.push(
      model.onDidChange(() => this.post()),
      alerts.onDidChange(() => this.post()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('prReminder.reviewers') || e.affectsConfiguration('prReminder.whatsapp') || e.affectsConfiguration('prReminder.chat') || e.affectsConfiguration('prReminder.alerts')) {
          this.post();
        }
      }),
    );
  }

  show(section?: string): void {
    if (this.panel) {
      this.panel.reveal(undefined, false);
    } else {
      this.panel = vscode.window.createWebviewPanel('prReminder.dashboard', 'PR Dashboard', vscode.ViewColumn.Active, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        retainContextWhenHidden: false,
      });
      this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
      this.panel.webview.html = this.html(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);
      this.panel.onDidDispose(() => (this.panel = null), null, this.disposables);
    }
    if (section) {
      void this.panel.webview.postMessage({ type: 'scrollTo', section });
    }
  }

  private post(): void {
    if (!this.panel) {
      return;
    }
    const alertsConfig = vscode.workspace.getConfiguration('prReminder.alerts');
    void this.panel.webview.postMessage({
      type: 'state',
      connection: this.connection(),
      status: this.model.status,
      prs: this.model.prs,
      events: this.model.events,
      unmapped: this.model.unmapped,
      failedMessages: this.model.failedMessages,
      error: this.model.lastError,
      mapping: vscode.workspace.getConfiguration('prReminder').get<Record<string, string>>('reviewers', {}),
      numbers: vscode.workspace.getConfiguration('prReminder').get<Record<string, string>>('whatsapp.numbers', {}),
      whatsappEnabled: vscode.workspace.getConfiguration('prReminder').get<boolean>('whatsapp.enabled', false),
      channels: {
        chat: vscode.workspace.getConfiguration('prReminder').get<boolean>('chat.enabled', true),
        whatsapp: vscode.workspace.getConfiguration('prReminder').get<boolean>('whatsapp.enabled', false),
      },
      alerts: {
        open: this.alerts.state.unacknowledged(),
        snoozedUntil: this.alerts.state.snoozeUntil(),
        quietMode: alertsConfig.get<boolean>('quietMode', false),
        size: alertsConfig.get<string>('size', 'normal'),
      },
      reminders: {
        intervalMinutes: vscode.workspace.getConfiguration('prReminder.reminders').get<number>('intervalMinutes', 30),
        maxRemindersPerReviewer: vscode.workspace.getConfiguration('prReminder.reminders').get<number>('maxRemindersPerReviewer', 5),
      },
    });
  }

  private async onMessage(raw: unknown): Promise<void> {
    const parsed = inbound.safeParse(raw);
    if (!parsed.success) {
      if ((raw as { type?: string })?.type === 'saveMapping') {
        const error = parsed.error.issues.map((i) => `${i.path.slice(1).join('.') || i.path.join('.')}: ${i.message}`).join('; ');
        void this.panel?.webview.postMessage({ type: 'saveResult', ok: false, error });
        void vscode.window.showErrorMessage(`Reviewer mapping not saved: ${error}`);
      }
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case 'ready':
        this.post();
        break;
      case 'refresh':
        await this.actions.refresh();
        break;
      case 'openUrl':
        this.alerts.openUrl(msg.url);
        break;
      case 'ack':
        await this.alerts.acknowledge(msg.ids);
        break;
      case 'snooze':
        await this.alerts.promptSnooze();
        break;
      case 'pause':
        await this.actions.pause(msg.prKey);
        break;
      case 'resume':
        await this.actions.resume(msg.prKey);
        break;
      case 'retryMessages':
        await this.actions.retryMessages(msg.ids);
        break;
      case 'clearMessages':
        await this.actions.clearMessages(msg.ids);
        break;
      case 'testChat':
        await this.actions.testChat();
        break;
      case 'setup':
        await vscode.commands.executeCommand('prReminder.setup');
        break;
      case 'setChannel':
        await vscode.commands.executeCommand(msg.enabled ? 'prReminder.enableChannel' : 'prReminder.disableChannel', { channel: msg.channel });
        this.post();
        break;
      case 'signInGoogle':
        await vscode.commands.executeCommand('prReminder.signInGoogle');
        break;
      case 'linkWhatsApp':
        await vscode.commands.executeCommand('prReminder.linkWhatsApp');
        break;
      case 'testWhatsApp':
        await vscode.commands.executeCommand('prReminder.testWhatsApp');
        break;
      case 'setAlertSize':
        await vscode.workspace.getConfiguration('prReminder.alerts').update('size', msg.size, vscode.ConfigurationTarget.Global);
        break;
      case 'previewBigAlert':
        await vscode.commands.executeCommand('prReminder.previewBigAlert');
        break;
      case 'customReminderInterval':
        await vscode.commands.executeCommand('prReminder.setReminderInterval');
        break;
      case 'setReminders': {
        const reminders = vscode.workspace.getConfiguration('prReminder.reminders');
        if (msg.intervalMinutes !== undefined) {
          await reminders.update('intervalMinutes', msg.intervalMinutes, vscode.ConfigurationTarget.Global);
        }
        if (msg.maxRemindersPerReviewer !== undefined) {
          await reminders.update('maxRemindersPerReviewer', msg.maxRemindersPerReviewer, vscode.ConfigurationTarget.Global);
        }
        break;
      }
      case 'saveMapping':
        try {
          // Emails and numbers are written together; the webview stays in edit mode until both are stored.
          // Numbers are stored as "+<digits>" so the settings file stays readable.
          const config = vscode.workspace.getConfiguration('prReminder');
          await config.update('reviewers', msg.mapping, vscode.ConfigurationTarget.Global);
          await config.update('whatsapp.numbers', Object.fromEntries(Object.entries(msg.numbers).map(([k, v]) => [k, `+${v}`])), vscode.ConfigurationTarget.Global);
        } catch (error) {
          void this.panel?.webview.postMessage({ type: 'saveResult', ok: false, error: (error as Error).message });
          break;
        }
        this.post();
        void this.panel?.webview.postMessage({ type: 'saveResult', ok: true });
        void vscode.window.showInformationMessage(
          `PR Reminder: saved ${Object.keys(msg.mapping).length} email(s) and ${Object.keys(msg.numbers).length} WhatsApp number(s).`,
        );
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'dashboard.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'dashboard.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>PR Dashboard</title>
</head>
<body>
<div id="app"><p class="muted">Loading…</p></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
