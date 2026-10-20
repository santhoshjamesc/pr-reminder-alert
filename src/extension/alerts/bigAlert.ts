import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { z } from 'zod';
import type { EventDto } from '../../shared/protocol';

const inbound = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('open'), id: z.number().int().positive() }),
  z.object({ type: z.literal('ack'), id: z.number().int().positive() }),
  z.object({ type: z.literal('ackAll') }),
  z.object({ type: z.literal('snooze') }),
  z.object({ type: z.literal('dismiss') }),
]);

export interface BigAlertActions {
  open(event: EventDto): void;
  acknowledge(ids: number[] | 'all'): Promise<void>;
  snooze(): Promise<void>;
}

/**
 * "Big" alert style: a black, full-bleed webview that takes over the active
 * editor area and states what happened on which PR. With `alerts.bigAlertFullWindow`
 * it also enters Zen mode so the overlay fills the whole window, and leaves Zen
 * mode again when it closes. Events queue up while it is open; it closes once
 * every shown event is acknowledged or dismissed.
 */
export class BigAlertOverlay implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private events: EventDto[] = [];
  /** Whether this overlay switched Zen mode on, so it only undoes its own change. */
  private enteredZenMode = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: BigAlertActions,
  ) {}

  show(events: EventDto[]): void {
    const known = new Set(this.events.map((e) => e.id));
    this.events = [...events.filter((e) => !known.has(e.id)), ...this.events];
    if (this.events.length === 0) {
      return;
    }
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, false);
      this.post();
      return;
    }
    this.panel = vscode.window.createWebviewPanel('prReminder.bigAlert', '🔔 PR ALERT', { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      retainContextWhenHidden: true,
    });
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => {
      this.panel = null;
      this.events = [];
      if (this.enteredZenMode) {
        this.enteredZenMode = false;
        void vscode.commands.executeCommand('workbench.action.exitZenMode');
      }
    }, null, this.disposables);
    if (vscode.workspace.getConfiguration('prReminder.alerts').get<boolean>('bigAlertFullWindow', true)) {
      this.enteredZenMode = true;
      void vscode.commands.executeCommand('workbench.action.toggleZenMode');
    }
  }

  /** Drops events acknowledged elsewhere; closes the overlay when nothing is left. */
  forget(ids: number[] | 'all'): void {
    if (!this.panel) {
      return;
    }
    this.events = ids === 'all' ? [] : this.events.filter((e) => !ids.includes(e.id));
    this.refresh();
  }

  hide(): void {
    this.panel?.dispose();
  }

  private refresh(): void {
    if (this.events.length === 0) {
      this.hide();
    } else {
      this.post();
    }
  }

  private post(): void {
    void this.panel?.webview.postMessage({
      type: 'events',
      events: this.events.map((e) => ({
        id: e.id,
        type: e.type,
        severity: e.severity,
        repo: e.repo,
        number: e.number,
        prTitle: e.prTitle,
        summary: e.summary,
        actor: e.actor,
        occurredAt: e.occurredAt,
      })),
    });
  }

  private async onMessage(raw: unknown): Promise<void> {
    const parsed = inbound.safeParse(raw);
    if (!parsed.success) {
      return;
    }
    const msg = parsed.data;
    const event = 'id' in msg ? this.events.find((e) => e.id === msg.id) : undefined;
    switch (msg.type) {
      case 'ready':
        this.post();
        break;
      case 'open':
        if (event) {
          this.actions.open(event);
          this.forget([event.id]);
          await this.actions.acknowledge([event.id]);
        }
        break;
      case 'ack':
        this.forget([msg.id]);
        await this.actions.acknowledge([msg.id]);
        break;
      case 'ackAll':
        this.hide();
        await this.actions.acknowledge('all');
        break;
      case 'snooze':
        this.hide();
        await this.actions.snooze();
        break;
      case 'dismiss':
        // Closes the overlay only; the alerts stay unacknowledged in the dashboard and status bar.
        this.hide();
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'bigAlert.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'bigAlert.css'));
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
<title>PR Alert</title>
</head>
<body>
<div id="app"></div>
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
