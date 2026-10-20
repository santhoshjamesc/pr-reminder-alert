import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BUILD_ID } from '../../shared/build';
import { redactString, registerSecret } from '../../shared/redact';
import { type Secrets, resolveGitHubToken } from '../secrets';
import { ApiClient } from './apiClient';

export type ConnectionState = 'stopped' | 'starting' | 'connected' | 'disconnected' | 'error';

interface ServiceInfoFile {
  port: number;
  pid: number;
  startedAt: string;
}

/** Environment variables passed through to the service process (everything else is dropped). */
const PASSTHROUGH_ENV = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];

/**
 * Starts or connects to the notification service.
 *
 * Local mode: reuses a service already started by another VS Code window
 * (found through a port file in global storage and verified with the shared
 * token), otherwise spawns one with VS Code's bundled Node runtime. Secrets
 * are passed only through the child's environment. With
 * prReminder.service.keepRunningWhenClosed on, the process is detached so
 * polling and reviewer reminders continue after VS Code quits; the next window
 * reconnects to it through the port file.
 *
 * Remote mode: connects to a configured https URL with a token kept in
 * SecretStorage.
 */
export class ServiceManager implements vscode.Disposable {
  private child: ChildProcess | null = null;
  private client: ApiClient | null = null;
  private state: ConnectionState = 'stopped';
  private restartTimes: number[] = [];
  private disposed = false;
  /** The spawned service is detached and outlives VS Code (prReminder.service.keepRunningWhenClosed). */
  private keepRunning = false;
  private readonly stateEmitter = new vscode.EventEmitter<ConnectionState>();
  readonly onDidChangeState = this.stateEmitter.event;
  lastError: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly secrets: Secrets,
    private readonly output: vscode.OutputChannel,
  ) {}

  get api(): ApiClient | null {
    return this.state === 'connected' ? this.client : null;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  /** True if this window launched the service process. */
  get ownsProcess(): boolean {
    return this.child !== null;
  }

  private setState(state: ConnectionState, error?: string): void {
    this.state = state;
    this.lastError = error ?? (state === 'connected' ? null : this.lastError);
    this.stateEmitter.fire(state);
  }

  private get infoFile(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'service.json');
  }

  async start(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.setState('starting');
    const config = vscode.workspace.getConfiguration('prReminder');
    try {
      if (config.get<string>('service.mode', 'local') === 'remote') {
        await this.connectRemote(config.get<string>('service.remoteUrl', ''));
      } else {
        await this.startLocal();
      }
      this.setState('connected');
    } catch (error) {
      const message = redactString(error instanceof Error ? error.message : String(error));
      this.output.appendLine(`[service] ${message}`);
      this.setState('error', message);
    }
  }

  private async connectRemote(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Set prReminder.service.remoteUrl to the remote service URL.');
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !loopback) {
      throw new Error('Remote service must use https:// (or a loopback address through an SSH tunnel).');
    }
    const token = await this.secrets.getRemoteApiToken();
    if (!token) {
      throw new Error('Remote API token missing. Run "PR Reminder: Set Remote Service API Token".');
    }
    const client = new ApiClient(parsed.origin, token);
    await client.status();
    this.client = client;
    this.output.appendLine(`[service] Connected to remote service ${parsed.origin}`);
  }

  private async startLocal(): Promise<void> {
    const token = await this.secrets.getOrCreateLocalApiToken();
    registerSecret(token);

    // Reuse a service started by another window.
    const existing = this.readInfoFile();
    if (existing) {
      const client = new ApiClient(`http://127.0.0.1:${existing.port}`, token);
      let status;
      try {
        status = await client.status();
      } catch {
        // stale file - start a new service
      }
      if (status && BUILD_ID > 0 && (status.build ?? 0) < BUILD_ID) {
        // Left running by an older build (e.g. before an update): it lacks newer API routes, so replace it.
        this.output.appendLine(`[service] Replacing local service from an older build on port ${existing.port}`);
        await client.shutdown().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 500));
      } else if (status) {
        this.client = client;
        this.output.appendLine(`[service] Connected to running local service on port ${existing.port}`);
        return;
      }
    }
    await this.spawnLocal(token);
  }

  private readInfoFile(): ServiceInfoFile | null {
    try {
      return JSON.parse(fs.readFileSync(this.infoFile, 'utf8')) as ServiceInfoFile;
    } catch {
      return null;
    }
  }

  private async spawnLocal(apiToken: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('prReminder');
    const dataDir = this.context.globalStorageUri.fsPath;
    fs.mkdirSync(dataDir, { recursive: true });
    this.keepRunning = config.get<boolean>('service.keepRunningWhenClosed', false);
    const githubToken = await resolveGitHubToken(this.secrets, config.get<string>('github.authMethod', 'pat'), false);
    const google = await this.secrets.getGoogle();
    registerSecret(githubToken);
    registerSecret(google.clientSecret);
    registerSecret(google.refreshToken);

    const env: NodeJS.ProcessEnv = {};
    for (const key of PASSTHROUGH_ENV) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }
    Object.assign(env, {
      PR_REMINDER_API_TOKEN: apiToken,
      PR_REMINDER_HOST: '127.0.0.1',
      PR_REMINDER_PORT: '0',
      PR_REMINDER_DATA_DIR: dataDir,
      PR_REMINDER_CONFIG: path.join(dataDir, 'config.json'),
      ...(this.keepRunning ? { PR_REMINDER_LOG_FILE: path.join(dataDir, 'service.log') } : { PR_REMINDER_EXIT_WITH_PARENT: '1' }),
      PR_REMINDER_ENV_FILE: path.join(dataDir, '.env-unused'),
      ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
      ...(google.clientId ? { GOOGLE_CLIENT_ID: google.clientId } : {}),
      ...(google.clientSecret ? { GOOGLE_CLIENT_SECRET: google.clientSecret } : {}),
      ...(google.refreshToken ? { GOOGLE_REFRESH_TOKEN: google.refreshToken } : {}),
    });

    const nodePath = config.get<string>('service.nodePath', '').trim();
    if (!nodePath) {
      env.ELECTRON_RUN_AS_NODE = '1';
    }
    const executable = nodePath || process.execPath;
    const script = this.context.asAbsolutePath(path.join('dist', 'service.js'));
    this.output.appendLine(`[service] Starting local notification service (${nodePath ? 'custom Node' : 'VS Code runtime'})`);

    const child = spawn(executable, ['--no-warnings', script], {
      env,
      // Detached: own process group with no stdin, so quitting VS Code does not stop it.
      stdio: [this.keepRunning ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: this.keepRunning,
      windowsHide: true,
    });
    this.child = child;

    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Service did not start within 20 seconds')), 20_000);
      let buffer = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const match = /PR_REMINDER_READY (\d+)/.exec(buffer);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Service exited during startup (code ${code}). See "PR Reminder: Show Service Logs".`));
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        this.output.appendLine(redactString(line));
      }
    });
    child.on('exit', (code, signal) => this.onChildExit(child, code, signal));
    if (this.keepRunning) {
      child.unref();
    }

    fs.writeFileSync(this.infoFile, JSON.stringify({ port, pid: child.pid ?? 0, startedAt: new Date().toISOString() } satisfies ServiceInfoFile), {
      mode: 0o600,
    });
    this.client = new ApiClient(`http://127.0.0.1:${port}`, apiToken);
    this.output.appendLine(`[service] Local service listening on 127.0.0.1:${port}`);
  }

  private onChildExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) {
      return;
    }
    this.child = null;
    this.client = null;
    if (this.disposed) {
      return;
    }
    this.output.appendLine(`[service] Service exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`);
    this.setState('disconnected', 'Service stopped unexpectedly');
    // Crash recovery with a restart budget of 5 restarts per 5 minutes.
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < 5 * 60_000);
    if (this.restartTimes.length >= 5) {
      this.setState('error', 'Service keeps crashing; restart it manually after checking the logs.');
      return;
    }
    this.restartTimes.push(now);
    setTimeout(() => void this.start(), 2000 * this.restartTimes.length);
  }

  /** Called when an API call fails: verifies the connection and reconnects if needed. */
  async checkConnection(): Promise<void> {
    if (this.state === 'starting' || this.disposed) {
      return;
    }
    if (this.client && (await this.client.health())) {
      if (this.state !== 'connected') {
        this.setState('connected');
      }
      return;
    }
    if (this.state === 'connected') {
      this.setState('disconnected', 'Lost connection to the notification service');
    }
    if (!this.child) {
      await this.start();
    }
  }

  async restart(): Promise<void> {
    await this.stopOwned();
    try {
      fs.rmSync(this.infoFile, { force: true });
    } catch {
      // ignore
    }
    // Ask any service started by another window to stop so new settings/secrets take effect.
    if (this.client) {
      await this.client.shutdown().catch(() => undefined);
    }
    this.client = null;
    this.restartTimes = [];
    await new Promise((r) => setTimeout(r, 500));
    await this.start();
  }

  private async stopOwned(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.child && !this.keepRunning) {
      // Closing stdin makes the service shut down gracefully; SIGTERM as a fallback.
      this.child.stdin?.end();
      this.child.kill('SIGTERM');
      try {
        fs.rmSync(this.infoFile, { force: true });
      } catch {
        // ignore
      }
    }
    this.stateEmitter.dispose();
  }
}
