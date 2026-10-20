# PR Reminder & Alert: Developer Reference

A VS Code extension and local notification service that:

- finds the GitHub pull requests **you** authored (created anywhere: website, CLI, other tools),
- sends each requested reviewer a **private Google Chat direct message, from your own account**, when their review is requested,
- sends **recurring reminder DMs** to each reviewer until *they* submit a review,
- stops reminders per reviewer on review, and for everyone when the PR is merged or closed,
- shows **hard-to-miss alerts** in VS Code (notifications, flashing in-editor banner, optional sound, status bar counter, optional repeat-until-acknowledged).

It uses no paid services: the GitHub REST API (polling), the Google Chat API (included with Google Workspace), and SQLite on your machine. It requires a **Google Workspace** account; consumer Gmail accounts cannot use the Chat API.

> **Important:** in local mode, polling, reviewer DMs and alerts run only while VS Code is open. When you close it, nothing is sent. Reminders that fell due in the meantime go out once when you open VS Code again; they do not pile up. To keep reviewer reminders going after you quit VS Code, turn on `prReminder.service.keepRunningWhenClosed`. If your computer is off or asleep, nothing is sent. Reminders that fell due during that time go out once, after the service starts again; they do not pile up. For reminders around the clock, run the service on an always-on machine (see [Always-on / remote mode](#always-on--remote-mode)).

---

## Contents

1. [Architecture](#architecture)
2. [Quick start](#quick-start)
3. [Credential setup (GitHub + Google Chat)](#credential-setup)
4. [Configuration reference](#configuration-reference)
5. [How reminders work](#how-reminders-work)
6. [Alerts](#alerts)
7. [Commands](#commands)
8. [Local development](#local-development)
9. [Packaging a VSIX](#packaging-a-vsix)
10. [Always-on / remote mode](#always-on--remote-mode)
11. [Service API](#service-api)
12. [Security](#security)
13. [Revoking and rotating credentials](#revoking-and-rotating-credentials)
14. [Troubleshooting](#troubleshooting)
15. [Limitations and future work](#limitations-and-future-work)

---

## Architecture

```
┌──────────────────────── VS Code (extension host) ────────────────────────┐
│ extension.ts ── commands, polling loop, wiring                           │
│ setupWizard.ts ── guided configuration                                   │
│ secrets.ts ── SecretStorage (GitHub token, Google sign-in, API token)    │
│ googleOAuth.ts ── Google sign-in (loopback redirect + PKCE)              │
│ service/serviceManager.ts ── spawn / reuse / reconnect the service        │
│ service/apiClient.ts ── typed HTTP client (Bearer token)                 │
│ views/ ── tree views (PRs, activity, status) + dashboard webview         │
│ alerts/ ── alertPolicy (pure), alertManager, banner, sound, status bar   │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ HTTP on 127.0.0.1, Authorization: Bearer <token>
┌──────────────────────────────▼──────── notification service (Node) ──────┐
│ api/server.ts ── authenticated, rate-limited JSON API                    │
│ service.ts ── composition root, sync + reminder loops, lifecycle         │
│ github/ ── Octokit gateway (read-only), throttling/retry, CI combinator  │
│ core/syncEngine.ts ── discover PRs, snapshot → events + reviewer state   │
│ core/eventDetector.ts ── diff → events with unique keys (dedup)          │
│ core/reviewerReconciler.ts ── per-reviewer request/response state        │
│ core/reminderEngine.ts ── persistent scheduler, lease lock, quiet hours  │
│ chat/ ── Google OAuth tokens, Chat REST client, templates, dispatcher    │
│ storage/ ── SQLite (node:sqlite), migrations, repositories               │
│ config/ ── Zod schemas, config store, secret loading                     │
│ logging/ ── JSON logger with secret & email redaction                    │
└──────────────────────────────────────────────────────────────────────────┘
```

**Data flow:** every `pollIntervalSeconds` the sync engine lists your open PRs (one `pulls.list` per configured repository, or the search API `is:pr is:open author:<you>` when no repositories are listed). It also re-checks every PR it already tracks as open, so merges and closures are noticed. For each PR it fetches details, reviews, issue comments, review comments, commits and CI status. It then compares that snapshot with SQLite and writes, in one transaction:

- **events** with deterministic unique keys (`review_submitted:<reviewId>`, `issue_comment:issue:<id>`, `commit_pushed:<pr>:<sha>`…). An event that already exists is ignored, so nothing is reported twice.
- **reviewer state**, reconciled against GitHub's *actual* requested reviewers and submitted reviews.
- **Google Chat messages** placed in a persistent **outbox** with idempotency keys (`reminder:<pr>:<login>:c<cycle>:n<k>`).

The reminder engine runs every 30 seconds and after each sync. It holds a DB lease while it works, so overlapping runs or a second service process cannot send twice. It queues due reminders, then the dispatcher delivers outbox rows: it looks up (or creates) the 1:1 DM with the reviewer, caches the DM space in SQLite, and posts the message. Each row is claimed atomically and re-checked just before sending (is the PR still open, is the reviewer still pending?).

The extension polls `GET /api/events?since=<lastId>` for new events and presents them according to your alert settings.

**Technology:** TypeScript, VS Code Extension API, Node.js, `@octokit/rest` (+ throttling/retry plugins), Google Chat REST API via `fetch` (no Google SDK), Zod, Vitest, esbuild, `@vscode/vsce`.

**SQLite library:** the service uses Node's built-in `node:sqlite` rather than `better-sqlite3`. A native addon would have to be compiled for every Electron ABI and platform to ship inside a VSIX. VS Code's bundled runtime (Node 24 in VS Code 1.129) and Node ≥ 22.13 both include `node:sqlite`, so the VSIX works on every platform with no native build step. Node prints an "experimental" warning for this module; the service starts with `--no-warnings` to hide it.

---

## Quick start

Requirements: VS Code ≥ 1.100, Node.js ≥ 22.13 (for development only; the packaged extension uses VS Code's own runtime).

```bash
npm install
npm run check        # typecheck + lint + tests
npm run package      # builds dist/ and creates pr-reminder-alert-x.y.z.vsix
code --install-extension pr-reminder-alert-x.y.z.vsix
```

Then in VS Code:

1. Run **PR Reminder: Run Setup Wizard** from the Command Palette. It asks for:
   - the GitHub auth method and token,
   - your GitHub username,
   - the repositories to watch (leave empty for all),
   - the reviewer → Workspace email mapping (used to find each reviewer in Google Chat),
   - Google Chat sign-in (your own Google Cloud OAuth client, see below),
   - the reminder interval and limit,
   - quiet hours,
   - your alert preferences.
2. Run **PR Reminder: Test Google Chat Connection** and pick *Send a test DM to …* to check that a reviewer receives it.
3. Open the **PR Reminder** icon in the Activity Bar (left sidebar), or **PR Reminder: Open PR Dashboard**.

The **first synchronization only records a baseline**. Existing comments, reviews and CI results do not trigger alerts, and reviewers on PRs that already exist get no "review requested" DM unless you enable `chat.sendInitialMessageForExistingPrs`. Pending reviewers on those PRs do get reminders starting one interval later.

---

## Credential setup

### GitHub token (least privilege)

**Recommended: fine-grained personal access token**

1. GitHub → *Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token*.
2. *Resource owner*: your account, or the organization that owns the repositories. Organizations may need to approve fine-grained tokens.
3. *Repository access*: **Only select repositories**, chosen to match `prReminder.github.repositories`.
4. *Repository permissions*, all **Read-only**:
   - **Pull requests**: PRs, reviews, review comments
   - **Issues**: PR conversation comments (GitHub stores these as issue comments)
   - **Commit statuses**: legacy CI statuses
   - **Checks**: GitHub Actions and other check runs (optional; without it, only commit statuses are used)
   - **Metadata**: granted automatically
5. Set an expiry date, then copy the token and paste it into the wizard, or run **PR Reminder: Set GitHub Personal Access Token**.

Tracking is **account-wide, not per workspace**: one background service per machine is shared by every VS Code window, all `prReminder.*` settings are user-level (application scope, so a folder's `.vscode/settings.json` cannot narrow them), and the default (empty list) tracks every PR you author in any repository or organization, whichever folder is open. Reviewers are only messaged once they are *requested* on the PR; a PR with no requested reviewers shows "no reviewers requested" in the PR Reminder panel.

If you monitor *all* repositories (empty list), the search API is used. A fine-grained token only sees the repositories it was granted. A classic token with `repo` scope sees every private repository you can access, so use it only if you need that.

**Alternative: VS Code GitHub sign-in** (`prReminder.github.authMethod: "vscode"`). This is convenient, but it requests the `repo` scope, which includes write access. The extension itself never writes: it only calls read endpoints and never approves, merges or edits PRs.

Team review requests (`@org/team`) need the token to be able to read the organization's PR data. Map the team to one person's Workspace email (for example the team lead) with `"@org/team-slug": "lead@company.com"`; Chat DMs go to people, not groups.

### Google Chat setup

Reviewer messages are sent **as you**, into your normal 1:1 chat with each reviewer. Reviewers install nothing.

**Free, one time, about 5 minutes.** Google only lets an app send Chat messages through an OAuth client registered in a Google Cloud project. Creating one costs nothing. Each user or company uses **their own** client, so there is no shared app, no Google review, and no user limit. One person can create the client and share the Client ID and secret with their team.

Requirements: a **Google Workspace** account with Google Chat. Personal Gmail accounts can't use the Chat API.

**A. Create the OAuth client** (skip if a teammate gave you a Client ID and secret)

1. [Create a Google Cloud project](https://console.cloud.google.com/projectcreate), e.g. "PR Reminder".
2. [Enable the Google Chat API](https://console.cloud.google.com/apis/library/chat.googleapis.com).
3. [Chat API → Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat): enter an app name ("PR Reminder"), an avatar URL and a description, turn **Interactive features off**, and save. Google requires this page even for user authentication.
4. [Google Auth Platform → Audience](https://console.cloud.google.com/auth/audience):
   - **Internal** if the project belongs to your company's Workspace. Everyone in your company can use it, and no verification is needed.
   - **External** if you created the project with a personal Google account. Leave it in *Testing* and add each user's work email under *Test users* (up to 100). In Testing mode Google expires sign-ins after 7 days, so you have to sign in again weekly.
5. [Data access → Add or remove scopes](https://console.cloud.google.com/auth/scopes): add
   - `https://www.googleapis.com/auth/chat.spaces.readonly` (find the DM with a reviewer)
   - `https://www.googleapis.com/auth/chat.spaces.create` (open a DM if you have never chatted)
   - `https://www.googleapis.com/auth/chat.messages.create` (send the message)
6. [Clients → Create client](https://console.cloud.google.com/auth/clients/create) → type **Desktop app**. Copy the **Client ID** (`….apps.googleusercontent.com`) and **Client secret** (`GOCSPX-…`).

**B. Sign in from VS Code**

1. Run **PR Reminder: Sign in to Google Chat** (or click the *Google Chat* row in the *Service & Warnings* sidebar view).
2. Paste the Client ID and the Client secret. The ID is saved in the setting `prReminder.chat.googleClientId`, and the secret in the OS keychain (Secret Storage). Surrounding spaces and quotes are removed.
3. Before opening the browser, the extension checks with Google that the client exists. If it does not, you get an `invalid_client` error right away with a **Re-enter client…** button (see [Troubleshooting](#troubleshooting)).
4. Your browser opens Google's account chooser and consent page. Pick your work account and click **Allow**.
5. Run **PR Reminder: Test Google Chat Connection → Send a test DM to <reviewer>**.

**Changing things later:** click the *Google Chat* row (or its ⚙ icon) in *Service & Warnings*, or run **PR Reminder: Manage Google Chat…**. The menu has:

- **Test Google Chat**: check the sign-in or send a test DM.
- **Sign in again / switch Google account**: signs in again with the same OAuth client. Google always shows the account chooser, so you can pick a different account.
- **Change OAuth client ID / secret…**: enter a different client, then sign in with it.
- **Sign out of Google Chat**: deletes the stored sign-in.
- **Turn Google Chat messages on/off.**

If sign-in shows **"access blocked"** (`admin_policy_enforced`), your Workspace admin restricts third-party apps. Ask them to allow your Client ID (Admin console → Security → API controls). `org_internal` means the client is Internal to a different Workspace: create your own, or set it to External.

**For forks:** a build can bundle a default client so users skip part A. Set `PR_REMINDER_GOOGLE_CLIENT_ID` and `PR_REMINDER_GOOGLE_CLIENT_SECRET` when running `npm run package`. A client shared with the public must be External and pass Google's OAuth verification (owned domain, privacy policy, demo video). Official builds ship without one.

For a **standalone service**, put the client ID and secret in `.env`, then run `npm run google-signin`. It opens the same consent page and prints a refresh token to paste into `GOOGLE_REFRESH_TOKEN`.

### WhatsApp (optional)

Reviewers can also get the same review-requested message and reminders on **WhatsApp**, sent from **your own WhatsApp account**. It works like pywhatkit, by driving WhatsApp Web, but in a separate background Chrome profile, so it never takes over your keyboard, mouse or normal browser.

1. Run **PR Reminder: Link WhatsApp (scan QR code)**. A Chrome window opens with WhatsApp Web. On your phone, open WhatsApp → **Linked devices** → **Link a device** and scan the code. The window closes by itself and WhatsApp is turned on (`prReminder.whatsapp.enabled`).
2. Open **PR Dashboard → Reviewer mapping** and fill in each reviewer's **WhatsApp number** with the country code, e.g. `+919876543210`. A reviewer can have an email, a number, or both. They are messaged on every channel they have.
3. Run **PR Reminder: Test WhatsApp Connection → Send a test WhatsApp message to …**. The notification shows each step as it happens (starting WhatsApp Web, opening the chat, sending, waiting for WhatsApp to confirm).

**Changing things later:** click the *WhatsApp* row (or its ⚙ icon) in *Service & Warnings*, or run **PR Reminder: Manage WhatsApp…**. The menu has **Test WhatsApp**, **Re-link WhatsApp** (scan the QR code again, e.g. for another phone), **Unlink WhatsApp**, and **Turn WhatsApp messages on/off**.

Details:

- **Requirements:** Google Chrome, Chromium, Edge or Brave must be installed (auto-detected, or set `prReminder.whatsapp.chromePath`). No other browser is downloaded.
- **Same rules as Chat:** quiet hours, reminder interval and limit, pause, stopping once a reviewer submits a review, and no duplicates after restarts.
- **Delivery check:** after sending, the extension waits for the tick on the new message. If the message is still waiting to go out in WhatsApp Web, it counts as sent, because WhatsApp sends it by itself. If the text is still in the message box, nothing was sent and it is retried. If delivery cannot be confirmed either way, the message is marked `failed` and **not** retried automatically, so a reviewer never gets it twice. Check the chat on your phone, then use **Retry** if needed.
- **Logged out:** if WhatsApp logs this computer out, messages stay queued (they are not lost or failed), the panel shows *WhatsApp: not linked*, and they go out after you link again.
- **Unlink:** run **PR Reminder: Unlink WhatsApp**, then remove the "Chrome" device under *Linked devices* on your phone.
- **Caveat:** automated WhatsApp Web use is not officially supported by WhatsApp. Keep it to normal reminder volumes. If WhatsApp changes its web page, sending can stop working until the extension is updated.

### Where secrets live

| Secret | Local mode | Standalone service |
| --- | --- | --- |
| GitHub token | VS Code SecretStorage (OS keychain) | `GITHUB_TOKEN` in `.env` |
| Google OAuth client ID/secret | VS Code SecretStorage | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` in `.env` |
| Google refresh token | VS Code SecretStorage | `GOOGLE_REFRESH_TOKEN` in `.env` |
| Service API token | generated, kept in SecretStorage | `PR_REMINDER_API_TOKEN` in `.env` |

In local mode the extension passes secrets to the service process **only through its environment**. The service reads them, then removes them from `process.env`. Secrets are never written to settings or to the config file, never sent to the webview, and never logged.

---

## Configuration reference

All settings are under `prReminder.*` (open them with **PR Reminder: Open Settings**). In local mode the extension turns them into the service config ([`examples/config.example.json`](examples/config.example.json) shows the same structure for a standalone service).

| Setting | Default | Meaning |
| --- | --- | --- |
| `github.username` | — | Your login; only PRs authored by it are tracked |
| `github.authMethod` | `pat` | `pat` or `vscode` |
| `github.repositories` | `[]` | `owner/name` list; empty = everything the token can see |
| `github.includeDrafts` | `true` | Track drafts. Reviewers of drafts are never messaged. |
| `github.pollIntervalSeconds` | `120` | GitHub polling interval (min 30) |
| `github.apiBaseUrl` | `https://api.github.com` | GitHub Enterprise Server: `https://host/api/v3` |
| `reviewers` | `{}` | `{ "login": "workspace-email", "@org/team": "workspace-email" }` |
| `chat.enabled` | `true` | Master switch for reviewer Google Chat DMs |
| `chat.sendInitialMessage` | `true` | DM reviewers when their review is requested |
| `chat.sendInitialMessageForExistingPrs` | `false` | Also DM reviewers on PRs found during the baseline |
| `chat.maxAttempts` | `5` | Delivery attempts before a message is marked failed |
| `reminders.intervalMinutes` | `30` | Time between reminders |
| `reminders.maxRemindersPerReviewer` | `5` | Per reviewer, per PR, per review request |
| `reminders.timeZone` | system | IANA zone used for quiet hours |
| `reminders.quietHours.enabled/start/end` | off, `22:00`–`08:00` | No reviewer messages in this window (may cross midnight) |
| `reminders.quietHours.quietDays` | `[]` | Whole days with no reviewer messages (0 = Sun) |
| `reminders.countCommentsAsResponse` | `false` | Treat a reviewer's comment as a response |
| `reminders.remindAfterChangesRequested` | `true` | Remind reviewers who requested changes again after new commits |
| `alerts.highPriorityStyles` | notification, banner, statusBar | Any of `notification`, `banner`, `sound`, `statusBar` |
| `alerts.normalPriorityStyles` | notification, statusBar | Same choices |
| `alerts.soundEnabled` | `false` | Allow sound (also add `sound` to a style list) |
| `alerts.soundFile` | — | Custom sound file |
| `alerts.repeatUntilAcknowledged` | `[]` | Event types that repeat, e.g. `["changes_requested","ci_failed","pr_merged"]` |
| `alerts.repeatIntervalSeconds` | `300` | Time between repeats |
| `alerts.flashBanner` / `alerts.bannerSeconds` | `true` / `0` | Banner flashing and auto-hide (0 = stays until acknowledged) |
| `alerts.quietMode` | `false` | Status bar only |
| `alerts.alertOnHistorical` | `false` | Alert on baseline events too |
| `alerts.severity` | `{}` | Override priorities, e.g. `{ "commit_pushed": "off" }` |
| `alerts.importantCommentKeywords` | `[]` | Reviewer comments containing one of these words are high priority. Empty = every reviewer comment is. |
| `alerts.pollSeconds` | `15` | How often VS Code asks the service for new events |
| `service.mode` | `local` | `local` or `remote` |
| `service.remoteUrl` | — | URL of a remote service (`https://…`) |
| `service.pushConfig` | `true` | Remote mode: send these settings to the service |
| `service.nodePath` | — | Run the service with this Node binary instead of VS Code's runtime |

### Reviewer mapping

Google Chat addresses people by their **Workspace email**, and GitHub does not reliably expose email addresses, so you map them yourself. The tool **never guesses or scrapes addresses**. It also ignores any address that appears in PR descriptions or comments. Add mappings:

- in the dashboard (**Reviewer mapping** section, with add/remove/save), or
- in `settings.json`:

```jsonc
"prReminder.reviewers": {
  "reviewer-one": "reviewer1@example.com",
  "reviewer-two": "reviewer2@example.com",
  "@example-org/platform-team": "platform-lead@example.com"
}
```

Login matching is case-insensitive. A requested reviewer with no mapping is **not messaged**. They appear as a warning in the *Service & Warnings* view and in the dashboard. Add a mapping later and their reminders start on the next sync.

---

## How reminders work

The rules below are all covered by automated tests (see `test/`).

- **Initial DM:** when a reviewer is newly requested (and the PR is not a draft), one "Your review is requested" Google Chat DM is queued, sent from your account into your 1:1 chat with them. It includes:
  - the PR title and number,
  - the repository,
  - the author,
  - all requested reviewers,
  - a direct link,
  - short instructions for reviewing.
- **Reminders:** sent every `intervalMinutes` after the request, up to `maxRemindersPerReviewer`. Each one shows how long ago the PR was opened, the link, and "reminder k of N".
- **Identifying the PR:** every message starts with a tag like `[owner/repo#12]` and links to the PR. Google Chat does not support reply threads in 1:1 DMs, so messages about different PRs appear one after another in the same chat. The tag tells them apart.
- **What counts as a response:** a submitted review with state `APPROVED`, `CHANGES_REQUESTED` or `COMMENTED`. Plain conversation comments and inline comments do **not** count unless `countCommentsAsResponse` is on. GitHub's "Add single comment" creates an empty `COMMENTED` review that only wraps inline comments, and that is treated as an inline comment, not a review.
- **Independent reviewers:** every reviewer has their own state, counter and schedule. One approval does not resolve other pending reviewers.
- **Re-requests:** if you re-request a reviewer after they responded, or after their request was removed, a new cycle starts: a fresh initial DM and a fresh reminder count.
- **Changes requested:** with `remindAfterChangesRequested` on, a reviewer who requested changes is asked to re-review once commits newer than their review are pushed.
- **Removed reviewers:** if you remove a review request, that reviewer's reminders stop and any queued messages to them are cancelled.
- **Merged/closed/inaccessible PRs:** all reminders stop and queued messages are cancelled. A PR that returns 404/403 three syncs in a row is marked *inaccessible* (deleted, or permission lost) and you get an alert.
- **Quiet hours:** messages that fall inside quiet hours, in the configured time zone, are pushed back to the first minute of the next allowed window. This handles DST changes.
- **Pause:** pause reminders globally (**PR Reminder: Pause Reminders**) or for a single PR (tree view inline button, or the dashboard). Queued messages wait until you resume.
- **Real GitHub state:** reminders are queued only when the PR was successfully synced within about the last 3 poll intervals plus 5 minutes. If GitHub is unreachable, reminders are held back rather than sent from stale data.
- **No duplicates after restart:** timestamps, counters, cycle numbers, event keys and the outbox are all stored in SQLite. Restarting never re-sends anything. If a crash happens *while* a message is being sent, delivery is uncertain, so that message is marked `failed` and is not re-sent automatically. You can retry it with **PR Reminder: Retry Failed Reviewer Messages**.
- **Chat API failures:** transient errors (network failures, HTTP 429, 5xx) are retried right away up to 3 times with exponential backoff. After that the outbox retries at 1, 2, 4, 8… minutes, capped at 1 h, up to `chat.maxAttempts`. Permanent errors (403 permission denied, user not found, a revoked Google sign-in) are marked failed immediately and shown in the dashboard with a **Retry** button. An expired access token is refreshed automatically. If a cached DM space disappears, it is looked up again.

---

## Alerts

| Priority | Events (defaults; override with `alerts.severity`) |
| --- | --- |
| **High** | PR merged, PR closed without merge, PR inaccessible, changes requested, review submitted, CI failed, important reviewer comment |
| **Normal** | PR opened/reopened, new comment, inline review comment, new commit, review requested/removed, CI passed, title/description/labels/assignees changed, branch deleted |

Each alert shows the repository, PR number and title, a short summary, and a link to the PR, review, comment or checks page. Every event is stored in a persistent history (the *Recent Activity* view and the dashboard).

### Reviewer Messages view

The *Reviewer Messages* view in the PR Reminder sidebar lists the latest 50 messages sent to reviewers on Google Chat and WhatsApp, newest first. Each row shows the reviewer, the PR, the channel and the status:

| Status | Meaning |
| --- | --- |
| waiting | Queued. Shows when it will be sent, or when the next retry is due. |
| sending | Being sent right now. For WhatsApp, the current step is shown, e.g. *Opening the chat with +91******3210…*. |
| sent | Delivered. Shows when. |
| failed | Gave up after `chat.maxAttempts`, a permanent error, or delivery that could not be confirmed. Click the retry icon on the row to retry that message. |
| cancelled | No longer needed, e.g. the PR was merged or the reviewer responded. |

Hover a row to see the masked recipient, the number of attempts and the last error. The view's title bar has **Retry Failed Reviewer Messages** and **Refresh**. While messages are waiting or sending, the view refreshes every `alerts.pollSeconds` instead of once a minute.

Alert styles:

1. **Notification**: a standard VS Code toast with *Open / Acknowledge / Snooze*. High priority uses the warning style.
2. **In-editor banner**: a bold, colored line decoration at the top of every visible editor, which flashes briefly. It never edits files and never takes focus.
3. **Sound** (opt-in): the system sound via `afplay` / PowerShell / `paplay`, at most once every 5 s.
4. **Status bar**: `🔔 3 PR alerts`, with a red background if any alert is high priority. Hover for a summary; click to open the dashboard.
5. **Repeat until acknowledged** (opt-in): selected event types re-alert every `repeatIntervalSeconds`.

When a lot happens at once (more than 3 events in one poll), you get one summary notification instead of a stack of them. **Acknowledge** marks alerts as seen in the service database. It does **not** change anything on GitHub or mark reviews complete. **Snooze** (15 min to 12 h) and **quiet mode** reduce alerts to the status bar counter only. Alerts never use modal dialogs, never steal focus, and do not try to bypass OS notification settings.

---

## Commands

| Command | Keybinding |
| --- | --- |
| PR Reminder: Refresh Pull Requests | — |
| PR Reminder: Open PR Dashboard | `Ctrl/Cmd+Alt+Shift+P` |
| PR Reminder: Pause Reminders / Resume Reminders | — |
| PR Reminder: Snooze Alerts | — |
| PR Reminder: Acknowledge All Alerts | `Ctrl/Cmd+Alt+Shift+A` |
| PR Reminder: Test Google Chat Connection | — |
| PR Reminder: Open Settings | — |
| PR Reminder: Open Selected PR | — |
| PR Reminder: Run Setup Wizard | — |
| PR Reminder: Filter Pull Requests / Clear Filter | — |
| PR Reminder: Retry Failed Reviewer Messages | — |
| PR Reminder: Toggle Quiet Mode | — |
| PR Reminder: Manage Google Chat (Sign In, Switch Account, Change Client)… | — |
| PR Reminder: Sign in to Google Chat / Sign in to Google Chat with Your Own OAuth Client… / Sign out of Google Chat | — |
| PR Reminder: Manage WhatsApp (Link, Re-link, Unlink)… | — |
| PR Reminder: Link WhatsApp (scan QR code) / Test WhatsApp Connection / Unlink WhatsApp | — |
| PR Reminder: Set GitHub Personal Access Token / Set Remote Service API Token | — |
| PR Reminder: Delete Stored Credentials | — |
| PR Reminder: Restart Notification Service / Show Service Logs | — |

You can filter the PR tree by repository, status (open, awaiting review, merged, closed, inaccessible) or reviewer. The dashboard has the same filters. Clicking a PR opens it in your browser.

---

## Local development

```bash
npm install
npm run dev          # esbuild watch for dist/extension.js and dist/service.js
# In VS Code press F5 ("Run Extension") - or:
code --extensionDevelopmentPath="$PWD"
```

| Script | Purpose |
| --- | --- |
| `npm run build` / `build:prod` | Bundle extension + service with esbuild |
| `npm run dev` / `watch` | Rebuild on change |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | ESLint (typescript-eslint) |
| `npm test` / `test:watch` | Vitest |
| `npm run check` | typecheck + lint + test |
| `npm run service` | Build and run the service standalone (reads `.env`) |
| `npm run package` | Create the VSIX |
| `npm run gen-token` | Print a random 32-byte API token |
| `npm run google-signin` | Get a Google refresh token for a standalone service |

**Running the service on its own while developing:**

```bash
cp .env.example .env            # fill in GITHUB_TOKEN, GOOGLE_CLIENT_ID/SECRET, PR_REMINDER_API_TOKEN
npm run google-signin           # prints GOOGLE_REFRESH_TOKEN for .env
npm run service
curl -s localhost:47615/health
curl -s -H "Authorization: Bearer $PR_REMINDER_API_TOKEN" localhost:47615/api/status
```

**Tests** use a fake GitHub gateway, mocked GitHub REST responses (a custom `fetch` passed to Octokit) a mock Google Chat transport, and mocked Google OAuth/Chat REST responses. **No real Chat messages are ever sent and no real GitHub or Google calls are made in tests.** The suites cover:

- author filtering
- reviewer mapping
- new-PR DMs and Chat text escaping
- reassignment
- scheduling, limits and quiet hours (including DST)
- per-reviewer stopping
- merge/close
- deduplication and historical suppression
- Google token refresh, DM lookup/creation, Chat API failures and retries
- the Google sign-in loopback flow (PKCE, state check)
- restart recovery
- alert acknowledgement and snoozing
- credential redaction
- API authentication and rate limiting

Project layout:

```
src/shared/       protocol DTOs, event types, redaction
src/service/      notification service (see Architecture)
src/extension/    VS Code extension
media/            dashboard webview script/styles, panel icon
test/             Vitest suites + helpers (fake GitHub, mock Google Chat)
src/tools/        standalone Google sign-in helper (npm run google-signin)
examples/         example configuration (fake users and addresses)
scripts/build.mjs esbuild bundling
```

---

## Packaging a VSIX

```bash
npm run package
# -> pr-reminder-alert-x.y.z.vsix (contains only dist/extension.js, dist/service.js, media/, README)
code --install-extension pr-reminder-alert-x.y.z.vsix
```

`vscode:prepublish` runs a minified production build. Dependencies are bundled by esbuild, so the package is built with `--no-dependencies`. Before publishing to the Marketplace, change `publisher` in `package.json`.

---

## Always-on / remote mode

To keep reminders going while your laptop is off, run the service on any always-on machine you control: a home server, a Raspberry Pi, or a small VM on a free tier.

```bash
git clone … && cd pr-reminder-alert && npm ci && npm run build
cp .env.example .env && chmod 600 .env    # fill in secrets, set PR_REMINDER_CONFIG to your config JSON
node --no-warnings dist/service.js        # or run under systemd / pm2 / launchd
```

Example systemd unit:

```ini
[Service]
WorkingDirectory=/opt/pr-reminder
ExecStart=/usr/bin/node --no-warnings dist/service.js
EnvironmentFile=/opt/pr-reminder/.env
Restart=on-failure
User=prreminder
```

Connecting VS Code to it:

- **Recommended:** keep `PR_REMINDER_HOST=127.0.0.1` on the server and use an SSH tunnel: `ssh -N -L 47615:127.0.0.1:47615 server`. Then set `prReminder.service.mode: "remote"` and `prReminder.service.remoteUrl: "http://127.0.0.1:47615"`.
- **Or:** put it behind a TLS reverse proxy (Caddy or nginx) and use `https://…`. The extension refuses plain `http://` to anything that is not a loopback address.
- Run **PR Reminder: Set Remote Service API Token** and enter the server's `PR_REMINDER_API_TOKEN`.

The extension never sends GitHub or Google secrets to a remote service; those stay in the server's `.env`. If `service.pushConfig` is on, the extension sends only the non-secret settings.

**Webhooks** are not implemented. Polling works everywhere without a public endpoint. A future webhook mode would add a `POST /webhooks/github` route that checks `X-Hub-Signature-256` and triggers an immediate sync of the affected PR; the event keys already make processing idempotent.

---

## Service API

All endpoints except `GET /health` require `Authorization: Bearer <PR_REMINDER_API_TOKEN>`. Other protections:

- tokens are compared in constant time,
- each client gets a token bucket (burst of 120 requests, refilling at 2 per second), and repeated authentication failures are throttled separately,
- request bodies are capped at 256 KB and validated with Zod,
- any request with an `Origin` header (that is, from a browser) is rejected, which blocks cross-site requests.

| Method & path | Body | Returns |
| --- | --- | --- |
| `GET /health` | — | `{ ok: true }` |
| `GET /api/status` | — | `ServiceStatusDto` (no secrets) |
| `GET /api/prs` | — | `PullRequestDto[]` (emails masked) |
| `GET /api/events?since=&limit=&historical=0\|1` | — | `EventDto[]` |
| `GET /api/unmapped` | — | reviewers without a Workspace email mapping |
| `GET /api/messages?limit=` | — | `MessageDto[]`: latest reviewer messages (Chat and WhatsApp) with status, newest first; `limit` 1–200, default 50 (recipient masked) |
| `GET /api/messages/failed` | — | failed Chat and WhatsApp deliveries (recipient masked) |
| `POST /api/sync` | `{}` | runs a sync + reminder tick |
| `POST /api/pause`, `POST /api/resume` | `{ prKey? }` | global or per-PR |
| `POST /api/alerts/ack` | `{ all: true }` or `{ ids: [] }` | marks alerts as seen (local only) |
| `POST /api/messages/retry` | `{ all: true }` or `{ ids: [] }` | re-queues failed messages |
| `POST /api/test-chat` | `{}` or `{ reviewer }` | checks Google sign-in; with `reviewer`, sends a test DM |
| `PUT /api/config` | config JSON | validates, saves, hot-reloads |
| `POST /api/shutdown` | `{}` | graceful stop |

Types are defined in [`src/shared/protocol.ts`](src/shared/protocol.ts).

---

## Security

- **Least privilege:** the GitHub integration only reads. No code path approves, merges, comments on or edits PRs.
- **Secrets:**
  - stored in the OS keychain (VS Code SecretStorage) or in a `chmod 600` `.env`,
  - never in settings, the config file, the webview or logs,
  - removed from the service's environment once read,
  - the child process gets an allow-listed environment.
- **Redaction:** every log line and API error goes through `src/shared/redact.ts`, which handles:
  - GitHub token formats (`ghp_`, `gho_`, `github_pat_`…),
  - Google access tokens (`ya29.`), refresh tokens (`1//`) and client secrets (`GOCSPX-`),
  - `Bearer` headers and `key=value` secrets,
  - the configured token values themselves,
  - email addresses, which are masked (`r***@example.com`).
- **Untrusted content:** in Chat messages, PR titles and logins are stripped of control characters, and Chat markup (`<…>` links and `<users/…>` mentions, `*bold*`, `_italic_`, `~strike~`, backticks) is replaced with look-alike characters, so a PR title cannot inject links or @mentions. The webview renders them with `textContent` only, under a strict CSP with a per-load nonce. Tree tooltips use untrusted `MarkdownString.appendText`. The UI opens only `https://` links on the configured GitHub host.
- **Recipients:** DMs go only to Workspace users in your mapping. Addresses found in PR text are ignored.
- **Google scopes:** only find-DM, create-DM and create-message. The tool cannot read your chats.
- **Local API:** binds to `127.0.0.1` with a random port in local mode and requires a 32+ character bearer token. It is rate limited and rejects browser origins.
- **Files:** the SQLite DB and config file are created `0600`; a standalone data directory is created `0700`. The data directory is VS Code's per-user global storage, which is outside your repositories. `.gitignore` excludes `.env`, `*.db`, logs and `data/`.
- **Validation:** all configuration, API bodies, query strings and webview messages are validated with Zod.

---

## Revoking and rotating credentials

- **GitHub PAT:** GitHub → *Settings → Developer settings → Personal access tokens* → **Revoke** (or *Regenerate*). Then run **PR Reminder: Set GitHub Personal Access Token**. For the VS Code sign-in, use *Accounts menu → GitHub → Sign out*, then revoke the "Visual Studio Code" OAuth app at *Settings → Applications → Authorized OAuth Apps* if you want.
- **Google sign-in:** <https://myaccount.google.com/permissions> → your PR Reminder app → **Remove access**. Then run **PR Reminder: Sign out of Google Chat** and sign in again. To rotate the OAuth client secret: Cloud console → *Google Auth Platform → Clients* → add a new secret, then run **Sign in to Google Chat** with it and delete the old secret.
- **Service API token:** local mode — run **PR Reminder: Delete Stored Credentials** (removes all stored secrets), then restart the service, and a new token is generated. Standalone — generate one with `npm run gen-token`, update `.env`, restart the service, then run **Set Remote Service API Token** in VS Code.
- **If a secret leaked:** revoke it first, then rotate it. Check GitHub's *Security log* and Google's *Recent security activity*.
- **Local data:** to wipe history, delete the extension's global storage folder: `~/Library/Application Support/Code/User/globalStorage/local-dev.pr-reminder-alert` on macOS, `%APPDATA%\Code\User\globalStorage\…` on Windows, `~/.config/Code/User/globalStorage/…` on Linux.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Status bar shows `PR Reminder` with a disconnected icon | Run **Show Service Logs**. **Restart Notification Service**. If it keeps crashing, check the error in the logs. Five crashes in 5 minutes stop the auto-restart. |
| "GitHub authentication failed" | The token is invalid, expired or revoked. Set a new one. For fine-grained tokens, check the repository selection and that the organization approved the token. |
| A repository's PRs are missing | Check the `owner/name` spelling and the token's repository access. The service log shows `Cannot list pull requests for repository` with a 403/404. |
| CI status always `none` | The token lacks *Checks* / *Commit statuses* read permission, or the repository has no CI. |
| Chat test: "Google sign-in is no longer valid" | The refresh token was revoked or expired (Internal apps do not expire tokens, but a password reset or an admin can revoke them). Run **Sign in to Google Chat** again. |
| Sign-in: "The OAuth client was not found" / `Error 401: invalid_client` | Google does not recognise the client ID. In Google Cloud → *APIs & Services → Credentials*, check that the client is type **Desktop app**, that it is in the project where the Google Chat API is enabled, and that the ID and secret were copied exactly. A newly created client can take a few minutes to start working. Then use **Manage Google Chat → Change OAuth client ID / secret…**. |
| WhatsApp: "did not confirm the message was sent (it may still go out)" | WhatsApp Web did not show a tick for the message in time. The message is marked `failed` and not retried, to avoid duplicates. Check the chat on your phone, then retry it in *Reviewer Messages* if it did not arrive. If this happens every time, set the log level to `debug` and look for `WhatsApp delivery check timed out`, which shows what the page looked like. |
| Sign-in: "access blocked" / `admin_policy_enforced` | Your Workspace admin restricts OAuth apps. Ask them to trust your project's client ID (Admin console → Security → API controls). |
| Chat error 403 "Chat API is enabled…" | Enable the Google Chat API in the same Cloud project as the OAuth client, and fill in its *Configuration* page. The reviewer must be a user in your Workspace (or external chat must be allowed). |
| Chat error 404 / "user not found" | The mapped email is not a Google Workspace user. Check the address in **Reviewer mapping**. |
| A reviewer gets no DM | Check that they have a mapping (*Service & Warnings*). Also check: the PR is not a draft, reminders are not paused, it is not quiet hours, and the reviewer has not hit the max count. |
| No alerts for old activity | Expected: the first sync records a baseline. Set `alerts.alertOnHistorical` to change this. |
| "Rate limit" in the sync error | The service backs off automatically until the reset time. Increase `pollIntervalSeconds` or list specific repositories instead of using the search API. |
| Alerts in two VS Code windows | Each window shows alerts from the same shared service. Acknowledge in one; the counter updates in the others on their next poll. |
| No sound | Set `alerts.soundEnabled: true` **and** add `sound` to a style list. Linux needs `paplay` or `aplay`. |
| Messages in `failed` state after a crash | Delivery status is unknown, so they are not re-sent automatically. Run **Retry Failed Reviewer Messages** if you are sure they were not delivered. |
| Custom Node runtime | Set `service.nodePath` to a Node ≥ 22.13 binary. |

Service logs are JSON lines with secrets and email addresses redacted. Set `PR_REMINDER_LOG_LEVEL=debug` (standalone) for more detail.

---

## Limitations and future work

- **No threads in DMs:** Google Chat 1:1 DMs have no reply threads, so each message is tagged `[owner/repo#N]` instead.
- **Workspace only:** the Chat API requires Google Workspace. Reviewers outside your domain can be messaged only if your admin allows external chat.
- **Polling only:** detection lags by up to `pollIntervalSeconds`. Webhook mode is a planned optional extension.
- **Team reviewers:** the service cannot see team membership. A team request is resolved when any non-author submits a review after the request.
- **Commit cap:** commits beyond the first 250 of a PR are not inspected for new-commit events.
- **Multiple windows:** each VS Code window shows alerts. The service and reviewer messages are shared and are never duplicated.
- **Not yet verified with live credentials:** in this repository, Google Chat delivery has been tested only against mocked Google OAuth/Chat responses and a mock transport, and GitHub only against mocked responses plus a live 401 check. **Before relying on it, do the Google Chat setup above and run *Test Google Chat Connection → Send a test DM* with your own account.**
