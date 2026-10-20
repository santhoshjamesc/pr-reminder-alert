import * as vscode from 'vscode';

interface SimulationRequest {
  id: string;
  fireAt: number;
}

const FILE_NAME = 'simulated-alert.json';
const POLL_MS = 5_000;
/** A request older than this when a window first sees it (e.g. VS Code was closed) is ignored. */
const STALE_MS = 2 * 60_000;
/** Gap between the normal sample alert and the big overlay, so both are noticed. */
const BIG_DELAY_MS = 10_000;

/**
 * Schedules sample alerts that fire in every open VS Code window. The request
 * lives in the extension's global storage, which all windows share, and each
 * window polls it, so the alert shows wherever the user is working.
 */
export class AlertSimulation implements vscode.Disposable {
  private readonly file: vscode.Uri;
  private readonly handled = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly poller: NodeJS.Timeout;

  constructor(
    storage: vscode.Uri,
    private readonly fire: { normal(): void; big(): void },
  ) {
    this.file = vscode.Uri.joinPath(storage, FILE_NAME);
    this.poller = setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  async schedule(delayMs: number): Promise<void> {
    const request: SimulationRequest = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, fireAt: Date.now() + delayMs };
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.file, '..'));
    await vscode.workspace.fs.writeFile(this.file, Buffer.from(JSON.stringify(request)));
  }

  private async poll(): Promise<void> {
    let request: SimulationRequest;
    try {
      request = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(this.file)).toString('utf8')) as SimulationRequest;
    } catch {
      return;
    }
    const now = Date.now();
    if (this.handled.has(request.id) || now < request.fireAt) {
      return;
    }
    this.handled.add(request.id);
    if (now - request.fireAt > STALE_MS) {
      return;
    }
    this.fire.normal();
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.fire.big();
    }, BIG_DELAY_MS);
    this.timers.add(timer);
  }

  dispose(): void {
    clearInterval(this.poller);
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
  }
}
