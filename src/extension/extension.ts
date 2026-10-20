import * as vscode from 'vscode';
import type { PullRequestDto, ServiceStatusDto } from '../shared/protocol';
import { redactString } from '../shared/redact';
import { AlertManager } from './alerts/alertManager';
import { AlertSimulation } from './alerts/simulation';
import { buildServiceConfig } from './configBuilder';
import { DataModel } from './model';
import { Secrets } from './secrets';
import { ServiceManager } from './service/serviceManager';
import { runSetupWizard, signInToGoogleChat } from './setupWizard';
import { DashboardPanel } from './views/dashboardPanel';
import type { Channel } from './views/treeViews';

const LAST_EVENT_KEY = 'prReminder.lastEventId';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('PR Reminder');
  const secrets = new Secrets(context.secrets);
  const service = new ServiceManager(context, secrets, output);
  const model = new DataModel(context.globalState);
  const settings = () => vscode.workspace.getConfiguration('prReminder');
  const alerts = new AlertManager(
    async (ids) => {
      await service.api?.acknowledge(ids);
      await refresh(false);
    },
    output,
    () => settings().get<string>('github.apiBaseUrl', 'https://api.github.com'),
    context.extensionUri,
  );
  const connection = () => ({ state: service.connectionState, error: service.lastError });

  const refresh = async (sync: boolean): Promise<void> => {
    const api = service.api;
    if (!api) {
      return;
    }
    try {
      if (sync) {
        const result = await api.sync();
        if (result.errors.length) {
          void vscode.window.showWarningMessage(`PR Reminder sync: ${result.errors[0]}`);
        }
      }
      await model.refresh(api);
      alerts.syncAcknowledged(model.events);
    } catch (error) {
      model.setError(redactString((error as Error).message));
      await service.checkConnection();
    }
  };

  const pollEvents = async (initial = false): Promise<void> => {
    const api = service.api;
    if (!api) {
      return;
    }
    try {
      const since = context.globalState.get<number>(LAST_EVENT_KEY, 0);
      const events = await api.events(initial ? 0 : since, 200);
      const maxId = events.reduce((m, e) => Math.max(m, e.id), since);
      if (maxId > since) {
        await context.globalState.update(LAST_EVENT_KEY, maxId);
      }
      // On startup, unacknowledged alerts are collected silently into one summary; afterwards each new event alerts.
      alerts.handle(initial ? events.filter((e) => !e.acknowledged) : events.filter((e) => e.id > since), initial);
      // Refresh while messages are waiting or being sent so their status stays current.
      if (events.length > 0 || model.hasActiveMessages()) {
        await model.refresh(api);
      }
    } catch {
      await service.checkConnection();
    }
  };

  const pushConfig = async (): Promise<void> => {
    const api = service.api;
    const local = settings().get<string>('service.mode', 'local') === 'local';
    if (!api || (!local && !settings().get<boolean>('service.pushConfig', true))) {
      return;
    }
    const config = buildServiceConfig(
      <T,>(key: string, fallback: T) => settings().get<T>(key, fallback) as T,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    const configured = Boolean(config.github.username);
    void vscode.commands.executeCommand('setContext', 'prReminder.configured', configured);
    if (!configured) {
      return;
    }
    try {
      await api.putConfig(config);
    } catch (error) {
      void vscode.window.showErrorMessage(`PR Reminder settings rejected: ${(error as Error).message}`);
    }
  };

  const dashboard = new DashboardPanel(
    context.extensionUri,
    model,
    alerts,
    {
      refresh: () => refresh(true),
      pause: (prKey) => setPaused(true, prKey),
      resume: (prKey) => setPaused(false, prKey),
      retryMessages: async (ids) => {
        const result = await service.api?.retryMessages(ids);
        void vscode.window.showInformationMessage(`PR Reminder: re-queued ${result?.requeued ?? 0} reviewer message(s).`);
        await refresh(false);
      },
      clearMessages: (ids) => clearFailedMessages(ids),
      testChat: () => testChat(),
    },
    connection,
  );

  const requireApi = () => {
    const api = service.api;
    if (!api) {
      void vscode.window.showErrorMessage('PR Reminder: the notification service is not connected.', 'Show Logs', 'Restart').then((c) => {
        if (c === 'Show Logs') {
          output.show();
        } else if (c === 'Restart') {
          void service.restart();
        }
      });
    }
    return api;
  };

  async function setPaused(paused: boolean, prKey?: string): Promise<void> {
    const api = requireApi();
    if (!api) {
      return;
    }
    await (paused ? api.pause(prKey) : api.resume(prKey));
    void vscode.window.showInformationMessage(`PR Reminder: reminders ${paused ? 'paused' : 'resumed'}${prKey ? ` for ${prKey}` : ''}.`);
    await refresh(false);
  }

  async function testChat(): Promise<void> {
    const api = requireApi();
    if (!api) {
      return;
    }
    const mapped = Object.keys(settings().get<Record<string, string>>('reviewers', {}));
    const choice = await vscode.window.showQuickPick(
      [{ label: 'Check sign-in only', reviewer: undefined as string | undefined }, ...mapped.map((r) => ({ label: `Send a test DM to ${r}`, reviewer: r }))],
      { placeHolder: 'Test Google Chat connection' },
    );
    if (!choice) {
      return;
    }
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Testing Google Chat…' }, () => api.testChat(choice.reviewer));
    if (result.ok) {
      void vscode.window.showInformationMessage(`PR Reminder: ${result.message}`);
    } else {
      void vscode.window.showErrorMessage(`PR Reminder: Google Chat test failed — ${result.message}`);
    }
  }

  /**
   * Polls the service while `task` runs so long operations (WhatsApp Web sends
   * take up to a minute) show what is happening instead of a bare spinner.
   */
  async function withLiveStatus<T>(task: Promise<T>, onStatus: (s: ServiceStatusDto) => void): Promise<T> {
    let done = false;
    const poll = async () => {
      while (!done) {
        const s = await service.api?.status().catch(() => undefined);
        if (s && !done) {
          onStatus(s);
          model.status = s;
        }
        await new Promise((r) => setTimeout(r, 800));
      }
    };
    void poll();
    try {
      return await task;
    } finally {
      done = true;
      void refresh(false);
    }
  }

  async function manageGoogleChat(): Promise<void> {
    const s = model.status;
    const on = settings().get<boolean>('chat.enabled', true);
    const signedIn = Boolean(s?.chatConfigured);
    const { clientId } = await secrets.getGoogle();
    const items: (vscode.QuickPickItem & { run: () => unknown })[] = [
      ...(signedIn ? [{ label: '$(beaker) Test Google Chat', description: 'check sign-in or send a test DM', run: () => testChat() }] : []),
      {
        label: signedIn ? '$(account) Sign in again / switch Google account' : '$(sign-in) Sign in to Google Chat',
        description: clientId ? `client ${clientId.slice(0, 12)}…` : undefined,
        run: () => vscode.commands.executeCommand('prReminder.signInGoogle'),
      },
      { label: '$(key) Change OAuth client ID / secret…', description: 'then sign in with it', run: () => vscode.commands.executeCommand('prReminder.signInGoogleCustomClient') },
      ...(signedIn ? [{ label: '$(sign-out) Sign out of Google Chat', run: () => vscode.commands.executeCommand('prReminder.signOutGoogle') }] : []),
      { label: on ? '$(circle-slash) Turn Google Chat messages off' : '$(check) Turn Google Chat messages on', run: () => setChannel('chat', !on) },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `Google Chat · ${on ? 'ON' : 'OFF'} · ${signedIn ? 'signed in' : 'not signed in'}` });
    await pick?.run();
  }

  async function manageWhatsApp(): Promise<void> {
    const s = model.status;
    const on = settings().get<boolean>('whatsapp.enabled', false);
    const linked = Boolean(s?.whatsappLinked);
    const items: (vscode.QuickPickItem & { run: () => unknown })[] = [
      ...(linked ? [{ label: '$(beaker) Test WhatsApp', description: 'check link or send a test message', run: () => testWhatsApp() }] : []),
      { label: linked ? '$(device-mobile) Re-link WhatsApp (scan QR again)' : '$(device-mobile) Link WhatsApp (scan QR)', run: () => linkWhatsApp() },
      ...(linked ? [{ label: '$(debug-disconnect) Unlink WhatsApp', run: () => vscode.commands.executeCommand('prReminder.unlinkWhatsApp') }] : []),
      { label: on ? '$(circle-slash) Turn WhatsApp messages off' : '$(check) Turn WhatsApp messages on', run: () => setChannel('whatsapp', !on) },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `WhatsApp · ${on ? 'ON' : 'OFF'} · ${linked ? 'linked' : 'not linked'}${s?.whatsappError ? ` · ${s.whatsappError}` : ''}` });
    await pick?.run();
  }

  async function testWhatsApp(): Promise<void> {
    const api = requireApi();
    if (!api) {
      return;
    }
    const mapped = Object.keys(settings().get<Record<string, string>>('whatsapp.numbers', {}));
    const choice = await vscode.window.showQuickPick(
      [{ label: 'Check link status only', reviewer: undefined as string | undefined }, ...mapped.map((r) => ({ label: `Send a test WhatsApp message to ${r}`, reviewer: r }))],
      { placeHolder: 'Test WhatsApp' },
    );
    if (!choice) {
      return;
    }
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Testing WhatsApp' }, (progress) =>
      withLiveStatus(api.testWhatsApp(choice.reviewer), (s) => progress.report({ message: s.whatsappActivity ?? (choice.reviewer ? 'working…' : 'checking link…') })),
    );
    if (result.ok) {
      void vscode.window.showInformationMessage(`PR Reminder: ${result.message}`);
    } else {
      void vscode.window.showErrorMessage(`PR Reminder: WhatsApp test failed — ${result.message}`);
    }
  }

  async function linkWhatsApp(): Promise<void> {
    const api = requireApi();
    if (!api) {
      return;
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'A Chrome window opened with WhatsApp Web: on your phone open WhatsApp → Linked devices → Link a device, and scan the QR code…' },
      () => api.linkWhatsApp(),
    );
    if (!result.ok) {
      void vscode.window.showErrorMessage(`PR Reminder: ${result.message}`);
      return;
    }
    if (!settings().get<boolean>('whatsapp.enabled', false)) {
      await settings().update('whatsapp.enabled', true, vscode.ConfigurationTarget.Global);
    }
    const next = await vscode.window.showInformationMessage(`PR Reminder: ${result.message}`, 'Add reviewer numbers');
    if (next) {
      dashboard.show('mapping');
    }
    await refresh(false);
  }

  /** Dismisses failed reviewer messages without sending them (all of them when `ids` is omitted, after confirming). */
  async function clearFailedMessages(ids?: number[]): Promise<void> {
    if (!ids) {
      const count = model.failedMessages.length;
      if (count === 0) {
        void vscode.window.showInformationMessage('PR Reminder: there are no failed reviewer messages.');
        return;
      }
      const ok = await vscode.window.showWarningMessage(`Clear ${count} failed reviewer message(s)? They will not be sent.`, { modal: true }, 'Clear');
      if (ok !== 'Clear') {
        return;
      }
    }
    const result = await requireApi()?.clearMessages(ids);
    if (result) {
      void vscode.window.showInformationMessage(`PR Reminder: cleared ${result.cleared} failed reviewer message(s).`);
      await refresh(false);
    }
  }

  /** Turns a reviewer-message channel on or off (flips it when `enabled` is omitted). */
  async function setChannel(channel: Channel, enabled?: boolean): Promise<void> {
    const key = channel === 'chat' ? 'chat.enabled' : 'whatsapp.enabled';
    const name = channel === 'chat' ? 'Google Chat' : 'WhatsApp';
    const on = enabled ?? !settings().get<boolean>(key, channel === 'chat');
    await settings().update(key, on, vscode.ConfigurationTarget.Global);
    const status = model.status;
    const needsSetup = on && status && (channel === 'chat' ? !status.chatConfigured : !status.whatsappLinked);
    if (needsSetup) {
      const action = channel === 'chat' ? 'Sign in to Google Chat' : 'Link WhatsApp';
      const choice = await vscode.window.showWarningMessage(`PR Reminder: ${name} messages are ON but ${channel === 'chat' ? 'not signed in' : 'not linked'} yet.`, action);
      if (choice) {
        await vscode.commands.executeCommand(channel === 'chat' ? 'prReminder.signInGoogle' : 'prReminder.linkWhatsApp');
      }
      return;
    }
    void vscode.window.showInformationMessage(`PR Reminder: ${name} messages to reviewers are ${on ? 'ON' : 'OFF'}.`);
  }

  const prArg = async (arg?: PullRequestDto | { url: string }): Promise<{ url: string; key?: string } | undefined> => {
    if (arg && 'url' in arg) {
      return arg as { url: string; key?: string };
    }
    const prs = model.filteredPrs();
    const choice = await vscode.window.showQuickPick(
      prs.map((pr) => ({ label: `#${pr.number} ${pr.title}`, description: pr.repo, pr })),
      { placeHolder: 'Select a pull request' },
    );
    return choice?.pr;
  };

  const register = (id: string, fn: (...args: never[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('prReminder.refresh', () => vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'PR Reminder: refreshing' }, () => refresh(true)));
  register('prReminder.openDashboard', (section?: string) => {
    dashboard.show(typeof section === 'string' ? section : undefined);
    void refresh(false);
  });
  register('prReminder.pause', () => setPaused(true));
  register('prReminder.resume', () => setPaused(false));
  register('prReminder.pausePr', async (pr?: PullRequestDto) => {
    const target = (await prArg(pr)) as PullRequestDto | undefined;
    if (target?.key) {
      await setPaused(true, target.key);
    }
  });
  register('prReminder.resumePr', async (pr?: PullRequestDto) => {
    const target = (await prArg(pr)) as PullRequestDto | undefined;
    if (target?.key) {
      await setPaused(false, target.key);
    }
  });
  register('prReminder.snooze', () => alerts.promptSnooze());
  register('prReminder.acknowledgeAll', () => alerts.acknowledge('all'));
  register('prReminder.testChat', () => testChat());
  register('prReminder.previewBigAlert', () => alerts.previewBig());
  const simulation = new AlertSimulation(context.globalStorageUri, { normal: () => alerts.previewNormal(), big: () => alerts.previewBig() });
  context.subscriptions.push(simulation);
  register('prReminder.simulateAlerts', async () => {
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'In 1 minute', minutes: 1 },
        { label: 'In 2 minutes', minutes: 2 },
        { label: 'In 5 minutes', minutes: 5 },
        { label: 'Now', minutes: 0 },
      ],
      { placeHolder: 'Show a sample normal alert, then the big alert 10 seconds later, in every open VS Code window' },
    );
    if (choice) {
      await simulation.schedule(choice.minutes * 60_000);
      void vscode.window.showInformationMessage(
        choice.minutes ? `PR Reminder: sample alerts will appear in ${choice.minutes} minute(s) in every open VS Code window.` : 'PR Reminder: showing sample alerts in a few seconds.',
      );
    }
  });
  register('prReminder.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-dev.pr-reminder-alert'));
  register('prReminder.openSelectedPr', async (arg?: PullRequestDto | { url: string }) => {
    const target = await prArg(arg);
    if (target) {
      alerts.openUrl(target.url);
    }
  });
  register('prReminder.setup', async () => {
    if (await runSetupWizard(secrets)) {
      await service.restart();
      const choice = await vscode.window.showInformationMessage('PR Reminder is configured.', 'Test Google Chat', 'Open Dashboard');
      if (choice === 'Test Google Chat') {
        await testChat();
      } else if (choice === 'Open Dashboard') {
        dashboard.show();
      }
    }
  });
  register('prReminder.filter', async () => {
    const kind = await vscode.window.showQuickPick(['Repository', 'Status', 'Reviewer'], { placeHolder: 'Filter pull requests by…' });
    if (!kind) {
      return;
    }
    const values =
      kind === 'Repository'
        ? [...new Set(model.prs.map((p) => p.repo))]
        : kind === 'Reviewer'
          ? [...new Set(model.prs.flatMap((p) => p.reviewers.map((r) => r.login)))]
          : ['open', 'needs-review', 'merged', 'closed', 'inaccessible'];
    const value = await vscode.window.showQuickPick(values.sort(), { placeHolder: `${kind}` });
    if (value) {
      const key = kind === 'Repository' ? 'repo' : kind === 'Reviewer' ? 'reviewer' : 'state';
      model.setFilter({ ...model.filter, [key]: value });
    }
  });
  register('prReminder.clearFilter', () => model.setFilter({}));
  register('prReminder.retryMessages', async () => {
    const result = await requireApi()?.retryMessages();
    if (result) {
      void vscode.window.showInformationMessage(`PR Reminder: re-queued ${result.requeued} failed reviewer message(s).`);
      await refresh(false);
    }
  });
  register('prReminder.clearFailedMessages', () => clearFailedMessages());
  register('prReminder.setReminderInterval', async () => {
    const current = settings().get<number>('reminders.intervalMinutes', 30);
    const value = await vscode.window.showInputBox({
      prompt: 'Minutes between reminder messages to a reviewer who has not responded (1–10080)',
      value: String(current),
      validateInput: (v) => (/^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 10080 ? undefined : 'Enter a whole number of minutes from 1 to 10080 (7 days).'),
    });
    if (value !== undefined) {
      await settings().update('reminders.intervalMinutes', Number(value.trim()), vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`PR Reminder: reviewers will be reminded every ${Number(value.trim())} minute(s).`);
    }
  });
  register('prReminder.toggleQuietMode', async () => {
    const current = settings().get<boolean>('alerts.quietMode', false);
    await settings().update('alerts.quietMode', !current, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`PR Reminder: quiet mode ${current ? 'off' : 'on'}.`);
  });
  register('prReminder.setGitHubToken', async () => {
    const token = await vscode.window.showInputBox({ prompt: 'GitHub personal access token (read-only fine-grained recommended)', password: true, ignoreFocusOut: true });
    if (token) {
      await secrets.setGitHubPat(token);
      await settings().update('github.authMethod', 'pat', vscode.ConfigurationTarget.Global);
      await service.restart();
    }
  });
  register('prReminder.toggleChat', () => setChannel('chat'));
  register('prReminder.toggleWhatsApp', () => setChannel('whatsapp'));
  register('prReminder.enableChannel', (node?: { channel?: Channel }) => (node?.channel ? setChannel(node.channel, true) : undefined));
  register('prReminder.disableChannel', (node?: { channel?: Channel }) => (node?.channel ? setChannel(node.channel, false) : undefined));
  register('prReminder.linkWhatsApp', () => linkWhatsApp());
  register('prReminder.testWhatsApp', () => testWhatsApp());
  register('prReminder.manageGoogleChat', () => manageGoogleChat());
  register('prReminder.manageWhatsApp', () => manageWhatsApp());
  register('prReminder.retryMessage', async (node?: { message?: { id: number } }) => {
    const id = node?.message?.id;
    const result = id ? await requireApi()?.retryMessages([id]) : undefined;
    if (result) {
      await refresh(false);
    }
  });
  register('prReminder.unlinkWhatsApp', async () => {
    await requireApi()?.unlinkWhatsApp();
    void vscode.window.showInformationMessage('PR Reminder: WhatsApp unlinked. Also remove "Chrome" under WhatsApp → Linked devices on your phone.');
    await refresh(false);
  });
  register('prReminder.signInGoogle', async () => {
    if (await signInToGoogleChat(secrets, false)) {
      await service.restart();
    }
  });
  register('prReminder.signInGoogleCustomClient', async () => {
    if (await signInToGoogleChat(secrets, true)) {
      await service.restart();
    }
  });
  register('prReminder.signOutGoogle', async () => {
    await secrets.clearGoogleSignIn();
    await service.restart();
    void vscode.window.showInformationMessage('PR Reminder: signed out of Google Chat. Revoke access at myaccount.google.com/permissions if needed.');
  });
  register('prReminder.setRemoteToken', async () => {
    const token = await vscode.window.showInputBox({ prompt: 'API token of the remote notification service', password: true, ignoreFocusOut: true });
    if (token) {
      await secrets.setRemoteApiToken(token);
      await service.restart();
    }
  });
  register('prReminder.clearSecrets', async () => {
    const ok = await vscode.window.showWarningMessage(
      'Delete the stored GitHub token, Google sign-in and service API tokens from VS Code Secret Storage?',
      { modal: true },
      'Delete',
    );
    if (ok === 'Delete') {
      await secrets.clearAll();
      await service.restart();
      void vscode.window.showInformationMessage('PR Reminder: credentials deleted. Also revoke them at GitHub and myaccount.google.com/permissions (see README).');
    }
  });
  register('prReminder.restartService', () => service.restart());
  register('prReminder.showLogs', () => output.show());

  context.subscriptions.push(
    output,
    service,
    model,
    alerts,
    dashboard,
    service.onDidChangeState((state) => {
      alerts.setConnection(state === 'connected' ? 'connected' : state === 'starting' ? 'starting' : 'disconnected');
      if (state === 'connected') {
        void pushConfig().then(() => refresh(false)).then(() => pollEvents(true));
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('prReminder')) {
        return;
      }
      alerts.reloadSettings();
      if (e.affectsConfiguration('prReminder.service') || e.affectsConfiguration('prReminder.github.authMethod')) {
        void service.restart();
      } else {
        void pushConfig().then(() => refresh(false));
      }
    }),
    vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === 'github' && settings().get<string>('github.authMethod') === 'vscode') {
        void service.restart();
      }
    }),
  );

  // Event polling and periodic data refresh.
  let pollTimer: NodeJS.Timeout | null = null;
  const schedulePoll = () => {
    const seconds = Math.max(5, settings().get<number>('alerts.pollSeconds', 15));
    pollTimer = setTimeout(async () => {
      await pollEvents();
      schedulePoll();
    }, seconds * 1000);
  };
  schedulePoll();
  const refreshTimer = setInterval(() => void refresh(false), 60_000);
  context.subscriptions.push({ dispose: () => (pollTimer && clearTimeout(pollTimer), clearInterval(refreshTimer)) });

  void vscode.commands.executeCommand('setContext', 'prReminder.configured', Boolean(settings().get<string>('github.username')));
  await service.start();
  if (!settings().get<string>('github.username')) {
    const choice = await vscode.window.showInformationMessage('PR Reminder: set up GitHub PR tracking and reviewer reminders?', 'Run Setup', 'Later');
    if (choice === 'Run Setup') {
      await vscode.commands.executeCommand('prReminder.setup');
    }
  }
}

export function deactivate(): void {
  // Disposables registered in activate() stop the service process this window owns.
}
