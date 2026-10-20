import * as vscode from 'vscode';
import { parseReviewerPairs } from './configBuilder';
import { InvalidGoogleClientError, signInWithGoogle } from './googleOAuth';
import { type Secrets, resolveGitHubToken } from './secrets';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function input(options: vscode.InputBoxOptions & { step: number; total: number }): Promise<string | undefined> {
  return vscode.window.showInputBox({ ...options, title: `PR Reminder Setup (${options.step}/${options.total})`, ignoreFocusOut: true });
}

async function pick<T extends vscode.QuickPickItem>(items: T[], step: number, total: number, placeHolder: string, canPickMany = false) {
  return vscode.window.showQuickPick(items, { title: `PR Reminder Setup (${step}/${total})`, placeHolder, ignoreFocusOut: true, canPickMany } as vscode.QuickPickOptions & { canPickMany: boolean });
}

/**
 * Guided configuration. Secrets go to SecretStorage; everything else is saved
 * as user settings (which the extension forwards to the service).
 */
export async function runSetupWizard(secrets: Secrets): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('prReminder');
  const target = vscode.ConfigurationTarget.Global;
  const TOTAL = 8;

  // 1. GitHub authentication method
  const auth = await pick(
    [
      { label: 'Personal access token (recommended)', description: 'fine-grained, read-only', value: 'pat' },
      { label: 'VS Code GitHub sign-in', description: 'uses the "repo" scope', value: 'vscode' },
    ],
    1,
    TOTAL,
    'How should PR Reminder authenticate to GitHub?',
  );
  if (!auth) {
    return false;
  }
  const method = (auth as unknown as { value: string }).value;
  if (method === 'pat') {
    const existing = await secrets.getGitHubPat();
    const token = await input({
      step: 1,
      total: TOTAL,
      prompt: 'GitHub token: fine-grained PAT with read-only Pull requests, Checks, Commit statuses and Metadata access.',
      password: true,
      placeHolder: existing ? '(leave empty to keep the stored token)' : 'github_pat_…',
    });
    if (token === undefined) {
      return false;
    }
    if (token.trim()) {
      await secrets.setGitHubPat(token);
    } else if (!existing) {
      void vscode.window.showWarningMessage('No GitHub token stored; PR detection will not work until you set one.');
    }
  } else if (!(await resolveGitHubToken(secrets, 'vscode', true))) {
    void vscode.window.showWarningMessage('GitHub sign-in was cancelled.');
  }
  await cfg.update('github.authMethod', method, target);

  // 2. Username
  let suggested = cfg.get<string>('github.username', '');
  if (!suggested && method === 'vscode') {
    const session = await vscode.authentication.getSession('github', ['repo'], { silent: true });
    suggested = session?.account.label ?? '';
  }
  const username = await input({
    step: 2,
    total: TOTAL,
    prompt: 'Your GitHub username (PRs authored by this account are tracked)',
    value: suggested,
    validateInput: (v) => (/^[A-Za-z0-9-]{1,39}$/.test(v.trim()) ? null : 'Enter a valid GitHub username'),
  });
  if (username === undefined) {
    return false;
  }
  await cfg.update('github.username', username.trim(), target);

  // 3. Repositories (default: every repository, independent of the open workspace)
  const currentRepos = cfg.get<string[]>('github.repositories', []);
  const scope = await pick(
    [
      { label: 'All my repositories (recommended)', description: 'every PR you author, in any repo or org the token can read', value: 'all', picked: currentRepos.length === 0 },
      { label: 'Only specific repositories…', value: 'some', picked: currentRepos.length > 0 },
    ],
    3,
    TOTAL,
    'Which pull requests should be tracked? (not tied to the folder open in VS Code)',
  );
  if (!scope) {
    return false;
  }
  if ((scope as unknown as { value: string }).value === 'all') {
    await cfg.update('github.repositories', [], target);
  } else {
    const repos = await input({
      step: 3,
      total: TOTAL,
      prompt: 'Repositories to monitor (owner/name, comma-separated). Leave empty for all repositories the token can access.',
      value: currentRepos.join(', '),
      validateInput: (v) => {
        const bad = v.split(',').map((s) => s.trim()).filter((s) => s && !REPO_PATTERN.test(s));
        return bad.length ? `Invalid: ${bad.join(', ')}` : null;
      },
    });
    if (repos === undefined) {
      return false;
    }
    await cfg.update('github.repositories', repos.split(',').map((s) => s.trim()).filter(Boolean), target);
  }

  // 4. Reviewer mapping
  const currentMap = cfg.get<Record<string, string>>('reviewers', {});
  const mapping = await input({
    step: 4,
    total: TOTAL,
    prompt: 'Reviewers\' Google Workspace emails (used to DM them in Google Chat) as login=email pairs, comma-separated, e.g. reviewer-one=reviewer1@company.com. Editable later in the dashboard.',
    value: Object.entries(currentMap).map(([k, v]) => `${k}=${v}`).join(', '),
    validateInput: (v) => {
      const { errors } = parseReviewerPairs(v);
      return errors.length ? `Could not parse: ${errors.join(', ')}` : null;
    },
  });
  if (mapping === undefined) {
    return false;
  }
  await cfg.update('reviewers', parseReviewerPairs(mapping).mapping, target);

  // 5. Google Chat (reviewers get private DMs from your own account)
  const chat = await pick(
    [
      { label: 'Sign in to Google Chat now', value: 'signin' },
      { label: 'Skip (no reviewer messages for now)', value: 'skip' },
    ],
    5,
    TOTAL,
    'Reviewers are messaged privately in Google Chat from your account',
  );
  if (!chat) {
    return false;
  }
  const chatEnabled = (chat as unknown as { value: string }).value === 'signin';
  await cfg.update('chat.enabled', chatEnabled, target);
  if (chatEnabled) {
    await signInToGoogleChat(secrets, false);
  }

  // 6. Reminder interval and limit
  const interval = await input({
    step: 6,
    total: TOTAL,
    prompt: 'Minutes between reminders, and maximum reminders per reviewer (e.g. "30, 5")',
    value: `${cfg.get<number>('reminders.intervalMinutes', 30)}, ${cfg.get<number>('reminders.maxRemindersPerReviewer', 5)}`,
    validateInput: (v) => (/^\s*\d+\s*,\s*\d+\s*$/.test(v) && Number(v.split(',')[0]) >= 1 ? null : 'Use "<minutes>, <max>" e.g. 30, 5'),
  });
  if (interval === undefined) {
    return false;
  }
  const [minutes, max] = interval.split(',').map((s) => Number(s.trim()));
  await cfg.update('reminders.intervalMinutes', minutes, target);
  await cfg.update('reminders.maxRemindersPerReviewer', max, target);

  // 7. Quiet hours
  const quiet = await input({
    step: 7,
    total: TOTAL,
    prompt: `Quiet hours for emails as HH:MM-HH:MM in ${Intl.DateTimeFormat().resolvedOptions().timeZone} (leave empty for none)`,
    value: cfg.get<boolean>('reminders.quietHours.enabled', false)
      ? `${cfg.get<string>('reminders.quietHours.start', '22:00')}-${cfg.get<string>('reminders.quietHours.end', '08:00')}`
      : '',
    validateInput: (v) => (!v.trim() || /^([01]\d|2[0-3]):[0-5]\d\s*-\s*([01]\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? null : 'Use HH:MM-HH:MM, e.g. 22:00-08:00'),
  });
  if (quiet === undefined) {
    return false;
  }
  if (quiet.trim()) {
    const [start, end] = quiet.split('-').map((s) => s.trim());
    await cfg.update('reminders.quietHours.enabled', true, target);
    await cfg.update('reminders.quietHours.start', start, target);
    await cfg.update('reminders.quietHours.end', end, target);
  } else {
    await cfg.update('reminders.quietHours.enabled', false, target);
  }

  // 8. Alert preferences
  const prefs = (await pick(
    [
      { label: 'In-editor banner for high-priority events', id: 'banner', picked: cfg.get<string[]>('alerts.highPriorityStyles', []).includes('banner') },
      { label: 'Sound for high-priority events', id: 'sound', picked: cfg.get<boolean>('alerts.soundEnabled', false) },
      { label: 'Repeat critical alerts until acknowledged (changes requested, CI failed, merged)', id: 'repeat', picked: cfg.get<string[]>('alerts.repeatUntilAcknowledged', []).length > 0 },
      { label: 'Quiet mode (status bar only)', id: 'quiet', picked: cfg.get<boolean>('alerts.quietMode', false) },
    ],
    8,
    TOTAL,
    'Alert preferences (select all that apply)',
    true,
  )) as unknown as Array<{ id: string }> | undefined;
  if (prefs === undefined) {
    return false;
  }
  const chosen = new Set(prefs.map((p) => p.id));
  await cfg.update('alerts.highPriorityStyles', ['notification', 'statusBar', ...(chosen.has('banner') ? ['banner'] : []), ...(chosen.has('sound') ? ['sound'] : [])], target);
  await cfg.update('alerts.soundEnabled', chosen.has('sound'), target);
  await cfg.update('alerts.repeatUntilAcknowledged', chosen.has('repeat') ? ['changes_requested', 'ci_failed', 'pr_merged'] : [], target);
  await cfg.update('alerts.quietMode', chosen.has('quiet'), target);
  return true;
}

const GOOGLE_CLIENT_STEPS = [
  'Google needs a free OAuth client from your own Google Cloud project (one time, about 5 minutes; one person can create it and share it with the team):',
  '',
  '1. Create a project (Google Cloud Console opens).',
  '2. Enable the Google Chat API, and on its Configuration page enter an app name, avatar URL and description (Interactive features off).',
  '3. Google Auth Platform → Audience: Internal (Workspace accounts). With a personal account choose External and add yourself as a test user.',
  '4. Data access → add the scopes chat.spaces.readonly, chat.spaces.create, chat.messages.create.',
  '5. Clients → Create client → Desktop app. Copy the Client ID and Client secret.',
  '',
  'Full steps with links: README → Google Chat setup.',
].join('\n');

/** Shows how to create an OAuth client; resolves false if the user cancels. */
async function explainGoogleClientSetup(): Promise<boolean> {
  const open = 'Open Google Cloud Console';
  const have = 'I have my Client ID';
  const choice = await vscode.window.showInformationMessage('Set up Google Chat (free)', { modal: true, detail: GOOGLE_CLIENT_STEPS }, open, have);
  if (choice === open) {
    await vscode.env.openExternal(vscode.Uri.parse('https://console.cloud.google.com/projectcreate'));
  }
  return choice !== undefined;
}

/**
 * Signs in through the browser and stores the refresh token. Uses the stored
 * or built-in OAuth client; asks for one (Desktop app, from your own Cloud
 * project) only when `askForClient` is set or no client is available.
 */
export async function signInToGoogleChat(secrets: Secrets, askForClient: boolean): Promise<boolean> {
  let { clientId, clientSecret } = await secrets.getGoogle();
  if (askForClient || !clientId || !clientSecret) {
    if (!clientId && !(await explainGoogleClientSetup())) {
      return false;
    }
    const id = await vscode.window.showInputBox({
      title: 'Google OAuth client',
      prompt: 'OAuth client ID (type "Desktop app") from your Google Cloud project with the Google Chat API enabled. See README → Google Chat setup.',
      value: clientId ?? '',
      ignoreFocusOut: true,
      validateInput: (v) => (/\.apps\.googleusercontent\.com$/.test(v.trim()) ? null : 'Client IDs end with .apps.googleusercontent.com'),
    });
    if (!id) {
      return false;
    }
    const secret = await vscode.window.showInputBox({
      title: 'Google OAuth client',
      prompt: 'OAuth client secret',
      password: true,
      placeHolder: clientSecret ? '(leave empty to keep the stored secret)' : 'GOCSPX-…',
      ignoreFocusOut: true,
    });
    if (secret === undefined || (!secret.trim() && !clientSecret)) {
      return false;
    }
    const clean = (v: string) => v.trim().replace(/^["']|["']$/g, '').trim();
    clientId = clean(id);
    clientSecret = clean(secret) || clientSecret;
    await secrets.setGoogleClient(clientId, clientSecret as string);
    await vscode.workspace.getConfiguration('prReminder').update('chat.googleClientId', clientId, vscode.ConfigurationTarget.Global);
  }
  try {
    const refreshToken = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Waiting for Google sign-in in your browser…', cancellable: false },
      () => signInWithGoogle({ clientId: clientId as string, clientSecret: clientSecret as string, openBrowser: (url) => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))) }),
    );
    await secrets.setGoogleRefreshToken(refreshToken);
    void vscode.window.showInformationMessage('PR Reminder: signed in to Google Chat. Reviewer reminders will be sent as DMs from your account.');
    return true;
  } catch (error) {
    if (error instanceof InvalidGoogleClientError) {
      const reenter = 'Re-enter client…';
      if ((await vscode.window.showErrorMessage(`PR Reminder: ${error.message}`, reenter)) === reenter) {
        return signInToGoogleChat(secrets, true);
      }
      return false;
    }
    void vscode.window.showErrorMessage(`PR Reminder: ${(error as Error).message}`);
    return false;
  }
}
