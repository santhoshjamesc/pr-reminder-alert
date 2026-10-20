# PR Reminder & Alert

**Never chase a code reviewer again.** PR Reminder & Alert watches the GitHub pull requests (PRs) you create, politely nags your reviewers for you on **Google Chat** and/or **WhatsApp** until they review, and shouts at *you* inside VS Code when something happens (a review, a comment, a merge).

*By Santhosh James C · MIT License*

---

## Contents

1. [What does it do? (30-second version)](#what-does-it-do)
2. [Before you start: what you need](#before-you-start)
3. [Install](#install)
4. [Setup, step by step (about 10 minutes)](#setup-step-by-step)
5. [Using it every day](#using-it-every-day)
6. [What your reviewers see](#what-your-reviewers-see)
7. [Settings you may want to change](#settings-you-may-want-to-change)
8. [Something is wrong? Fix it here](#something-is-wrong)
9. [Privacy and safety](#privacy-and-safety)
10. [FAQ](#faq)
11. [Quick reference for AI assistants](#quick-reference-for-ai-assistants)
12. [Developers](#developers)

---

## What does it do?

Imagine you open a pull request on GitHub and ask Priya to review it. Priya is busy and forgets. Normally you would have to message her yourself, again and again.

With this extension:

| What happens on GitHub | What this extension does |
| --- | --- |
| You ask Priya to review your PR | Sends Priya a private message: "Your review is requested" |
| Priya has not reviewed after 30 minutes | Sends a friendly reminder (and again every 30 minutes, up to 5 times) |
| Priya submits a review | **Stops** reminding her. Shows you an alert in VS Code |
| Someone comments, CI fails, or the PR is merged | Shows you an alert in VS Code |

It only **reads** GitHub. It never approves, merges, comments on or edits anything.

> **Good to know:** reminders are sent while **VS Code is open** (and your computer is awake). If you close VS Code, they pause and catch up when you reopen it. To keep them going after you close VS Code, turn on the setting `PR Reminder › Service › Keep Running When Closed`.

---

## Before you start

You need:

- **VS Code** version 1.100 or newer (Help → About shows your version).
- A **GitHub account** and some pull requests you created.
- *Only if you want reviewers messaged on Google Chat:* a **Google Workspace** account (work or school email, e.g. `you@company.com`). A normal `@gmail.com` address **cannot** do this.
- *Only if you want reviewers messaged on WhatsApp:* **WhatsApp on your phone** and **Google Chrome, Edge, Brave or Chromium** on your computer.

No messaging account? You can still use the alerts-for-yourself part. Just skip steps 3 and 4 below.

---

## Install

**Option A: from the Marketplace** (when published)
1. In VS Code, click the **Extensions** icon on the left (four squares), or press `Cmd+Shift+X` (Mac) / `Ctrl+Shift+X` (Windows/Linux).
2. Search **PR Reminder & Alert** and click **Install**.

**Option B: from a `.vsix` file**
1. Open the Extensions panel (as above).
2. Click the **`…`** (three dots) at the top of the panel → **Install from VSIX…**
3. Pick the `pr-reminder-alert-x.y.z.vsix` file.

When it installs, a **PR Reminder** icon appears in the left bar and a **Get Started** page may open. You can follow that page or this manual; they say the same thing.

> **Tip:** The **Command Palette** is VS Code's "search for any action" box. Open it with `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux), then type the command name. Every "run X" below means this.

---

## Setup, step by step

### Step 1: Create a GitHub token (a read-only key)

A **token** is a long secret text that proves to GitHub "this extension may look at my PRs".

1. Go to <https://github.com/settings/personal-access-tokens/new> (log in if asked).
2. **Token name:** type `PR Reminder`.
3. **Expiration:** choose 90 days. (When it expires, just make a new one and repeat step 6.)
4. **Repository access:** choose **Only select repositories** and pick the repositories you want watched.
   - If the repos belong to a company/organization, change **Resource owner** to that organization first. Its admin may need to approve the token.
5. Scroll to **Repository permissions** and set these four to **Read-only**:
   - Pull requests
   - Issues
   - Commit statuses
   - Checks
6. Click **Generate token**. **Copy it immediately.** GitHub only shows it once.
7. In VS Code, open the Command Palette and run **PR Reminder: Set GitHub Personal Access Token**. Paste the token and press Enter.

✅ Your token is saved in your computer's secure keychain, not in any file.

### Step 2: Run the setup wizard

1. Command Palette → **PR Reminder: Run Setup Wizard**.
2. Answer each question. **If you are not sure, just press Enter**: the defaults are safe.

| The wizard asks | It means | What to type |
| --- | --- | --- |
| GitHub username | Your login name on GitHub | e.g. `octocat` |
| Repositories to watch | Which repos to track | Leave **empty** to watch all your PRs |
| Reviewer → email mapping | Who is who (you can do it later) | Skip for now |
| Reminder interval | Minutes between reminders | `30` |
| Max reminders | Stop nagging after this many | `5` |
| Quiet hours | No messages at night | Turn on, `22:00` to `08:00` |
| Alert style | How loud alerts are | `normal` (you can change it later) |

The first time it syncs, it only **remembers what already exists**. You will not get alerts for old comments. That is normal.

### Step 3 (optional): Let reviewers be messaged on Google Chat

Reviewers get a private Google Chat message **sent from your account**. They install nothing.

Google requires a one-time **free** setup (about 5 minutes) so it knows which app is sending. You are creating *your own private key*; nobody else shares it.

> **Easier:** if a teammate already did this, ask them for the **Client ID** and **Client secret** and jump to **B**.

**A. Create the Google "OAuth client"**

1. Go to <https://console.cloud.google.com/projectcreate>, name it `PR Reminder`, click **Create**.
2. Open <https://console.cloud.google.com/apis/library/chat.googleapis.com> and click **Enable**.
3. Open <https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat> (the *Configuration* tab). Fill in: App name `PR Reminder`, any avatar image URL, a short description. Turn **Interactive features OFF**. Click **Save**.
4. Open <https://console.cloud.google.com/auth/audience>:
   - If it says **Internal**, leave it. (Best: everyone in your company can use it.)
   - If it asks you to choose, pick **Internal** if you can, otherwise **External**. For External, click **Add users** and add your work email under *Test users*. (External apps in "Testing" ask you to sign in again every 7 days.)
5. Open <https://console.cloud.google.com/auth/scopes>, click **Add or remove scopes**, and add these three (paste each in the filter box):
   - `https://www.googleapis.com/auth/chat.spaces.readonly`
   - `https://www.googleapis.com/auth/chat.spaces.create`
   - `https://www.googleapis.com/auth/chat.messages.create`

   Click **Update**, then **Save**.
6. Open <https://console.cloud.google.com/auth/clients/create>. Application type: **Desktop app**. Name: `PR Reminder`. Click **Create**.
7. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret** (starts with `GOCSPX-`).

**B. Sign in from VS Code**

1. Command Palette → **PR Reminder: Sign in to Google Chat**.
2. Paste the Client ID, then the Client secret.
3. Your browser opens. Choose your **work** account and click **Allow**.
4. Command Palette → **PR Reminder: Test Google Chat Connection** → *Send a test DM*. Check your Google Chat.

✅ Got the test message? Chat is working.

**C. Tell it your reviewers' emails**

Google Chat needs an email, but GitHub only gives a username. So you connect them once:

1. Command Palette → **PR Reminder: Open PR Dashboard**.
2. Find **Reviewer mapping**.
3. Add rows like `priya-dev` → `priya@company.com`.

Team reviewers (like `@my-org/backend-team`) are groups, and Chat messages go to people. Map the team to one person (e.g. the team lead).

### Step 4 (optional): Let reviewers be messaged on WhatsApp

1. Command Palette → **PR Reminder: Link WhatsApp (scan QR code)**.
2. A Chrome window opens showing a **QR code**.
3. On your phone: **WhatsApp → Linked devices → Link a device**, then point the camera at the QR code.
4. The window closes by itself. Done.
5. In the dashboard's **Reviewer mapping**, add each reviewer's phone number **with country code**, e.g. `+919876543210` (no spaces).
6. Command Palette → **PR Reminder: Test WhatsApp Connection**.

A reviewer can have an email, a number, or both. They get messages on every channel you gave them.

> ⚠️ WhatsApp does not officially support automated sending. Use it for normal reminder volumes only.

### Step 5: Look at your dashboard

Click the **PR Reminder** icon on the left bar. You will see your open PRs, who still owes you a review, and any messages queued or failed. 🎉

---

## Using it every day

You mostly do nothing. Open VS Code, work normally, and watch the status bar at the bottom for the counter of unread PR alerts.

| I want to… | Do this |
| --- | --- |
| See my PRs and reviewers | Click the **PR Reminder** icon on the left bar |
| Open the full dashboard | `Cmd+Alt+Shift+P` (Mac) / `Ctrl+Alt+Shift+P` (Windows/Linux) |
| Dismiss all alerts | `Cmd+Alt+Shift+A` (Mac) / `Ctrl+Alt+Shift+A` |
| Stop all reminders for now | Command Palette → **PR Reminder: Pause Reminders** (and **Resume Reminders** later) |
| Stop reminders for one PR | Click the pause button next to that PR in the sidebar |
| Silence pop-ups for a while | **PR Reminder: Snooze Alerts**, or **Toggle Quiet Mode** |
| Change how often reviewers are nudged | **PR Reminder: Set Reviewer Reminder Interval** |
| See which messages were sent/failed | Sidebar → **Reviewer Messages** |
| Re-send a failed message | **PR Reminder: Retry Failed Reviewer Messages** |
| Preview what a big alert looks like | **PR Reminder: Preview Big Alert** |

**Reminders stop automatically** when a reviewer submits a review, when you remove them, or when the PR is merged or closed.

---

## What your reviewers see

A normal chat message from you, like:

> **[my-org/my-app#42] Your review is requested**
> Add login rate limiting, by you
> https://github.com/my-org/my-app/pull/42

Then, if they have not reviewed, short reminders like "Reminder 2 of 5: opened 1 hour ago". The `[my-org/my-app#42]` tag at the start tells them which PR it is about. Draft PRs are never messaged.

---

## Settings you may want to change

Open VS Code Settings (`Cmd+,` / `Ctrl+,`) and search **PR Reminder**. The ones beginners usually touch:

| Setting | Default | In plain words |
| --- | --- | --- |
| `Reminders › Interval Minutes` | 30 | Minutes between nudges to one reviewer |
| `Reminders › Max Reminders Per Reviewer` | 5 | Stop after this many nudges |
| `Reminders › Quiet Hours › Enabled / Start / End` | off, 22:00, 08:00 | No messages to reviewers in this window |
| `Reminders › Time Zone` | your system's | Which clock quiet hours use |
| `Reminders › Count Comments As Response` | off | If on, a plain comment from a reviewer also stops reminders |
| `Alerts › Size` | normal | `big` shows a large black overlay for important events |
| `Alerts › Sound Enabled` | off | Play a sound (also add `sound` in the alert styles) |
| `Alerts › Quiet Mode` | off | Only the status-bar counter, no pop-ups |
| `Github › Repositories` | all | List `owner/name` to watch only some repos |
| `Github › Poll Interval Seconds` | 120 | How often GitHub is checked |
| `Service › Keep Running When Closed` | off | Keep sending reminders after VS Code closes |

---

## Something is wrong?

First, two universal fixes: Command Palette → **PR Reminder: Restart Notification Service**, and **PR Reminder: Show Service Logs** (read the last lines for the reason).

| What you see | Why | Fix |
| --- | --- | --- |
| Status bar says "PR Reminder" with a broken/disconnected icon | The background helper stopped | **Restart Notification Service**, then **Show Service Logs** |
| "GitHub authentication failed" | Token is wrong, expired, or the organization has not approved it | Make a new token (Step 1) and set it again |
| One repo's PRs never show up | Typo in `owner/name`, or the token was not given that repo | Check spelling; recreate the token including that repo |
| No alerts about old comments | Expected: the first sync only records what exists | Nothing to fix |
| A reviewer gets no message | Not mapped to an email/number, PR is a draft, you paused reminders, it is quiet hours, or they already got the max count | Check the **Reviewer mapping** and those settings |
| Google sign-in: `invalid_client` / "OAuth client was not found" | Client ID or secret mistyped, or it is not a *Desktop app* client | Use **Manage Google Chat → Change OAuth client**. A brand-new client can take a few minutes to work |
| Google: "access blocked" / `admin_policy_enforced` | Your Workspace admin blocks outside apps | Ask the admin to allow your Client ID (Admin console → Security → API controls) |
| Google: `org_internal` | The client belongs to a different company | Create your own client (Step 3) |
| Chat error 403 | Chat API not enabled, or its Configuration page not saved | Redo Step 3 A2 and A3 |
| Chat error 404 / "user not found" | The email is not a Workspace user | Fix the email in **Reviewer mapping** |
| Google asks you to sign in every week | Your client is *External* in Testing mode | Switch to *Internal*, or just sign in again weekly |
| WhatsApp: "did not confirm the message was sent" | It may still have been delivered | Check your phone. Use **Retry** in *Reviewer Messages* only if it did not arrive (no automatic retry, to avoid duplicates) |
| WhatsApp says "not linked" | WhatsApp logged this computer out | **Manage WhatsApp → Re-link**. Queued messages send afterwards |
| No sound | Sound needs two switches | Turn on `Alerts › Sound Enabled` **and** add `sound` to an alert style |
| Messages marked `failed` after a crash | Delivery status unknown, so not re-sent automatically | Check the chat, then **Retry Failed Reviewer Messages** if needed |
| "Rate limit" | GitHub asked us to slow down | Wait; it recovers by itself. Optionally raise the poll interval or list specific repos |

Still stuck? Open an issue and attach the output of **PR Reminder: Show Service Logs** (emails and secrets are already hidden in the logs).

---

## Privacy and safety

- Your tokens are stored in your operating system's keychain via VS Code Secret Storage. They are never written to settings files, never sent to the dashboard page, and never logged.
- Everything runs **on your computer**. There is no server run by the author, no tracking, and no analytics. The only network calls go to GitHub, Google Chat and (optionally) WhatsApp Web, using your own accounts.
- The extension only **reads** GitHub. It cannot merge, approve or edit.
- The small local helper listens only on `127.0.0.1` (your own machine) and requires a secret key.
- PR titles and reviewer emails are stored in a local database file on your computer.

**Remove everything:** Command Palette → **PR Reminder: Delete Stored Credentials**, then revoke the GitHub token at <https://github.com/settings/personal-access-tokens> and Google access at <https://myaccount.google.com/permissions>. For WhatsApp, run **Unlink WhatsApp** and remove "Chrome" under *Linked devices* on your phone.

---

## FAQ

**Do my reviewers need to install anything?** No. They just receive a normal chat message.

**Does it cost money?** No. GitHub's API, Google Chat's API and local storage are free. (Google Chat needs a Workspace account you already pay for.)

**Will it message people about other people's PRs?** No. Only PRs **you** created, and only reviewers who were actually requested on them.

**Can I use it with GitHub Enterprise?** Yes. Change `Github › Api Base Url` to your server's API address.

**Why did a reviewer not get a message for a PR that already existed?** By design, the first sync does not message for existing PRs (to avoid spamming). They still get reminders one interval later. Turn on `Chat › Send Initial Message For Existing Prs` if you want the first message too.

**Does a comment from a reviewer count as a review?** Not by default. Only a submitted review (Approve / Request changes / Comment) does. Change it with `Reminders › Count Comments As Response`.

**I use several VS Code windows. Will reviewers get duplicates?** No. One shared helper handles all windows.

**Not yet verified with live accounts:** automated tests cover the logic with simulated GitHub/Google responses. Before depending on it, run the **Test Google Chat Connection** step with your own account.

---

## Quick reference for AI assistants

*This section is written so an AI coding/chat assistant can help a user set the extension up accurately. Facts here are authoritative; do not invent other commands or settings.*

**Identity:** VS Code extension id `santhosh-james-c.pr-reminder-alert`, display name "PR Reminder & Alert". Requires VS Code ≥ 1.100. Local-only; no hosted backend.

**Purpose:** Poll GitHub for PRs authored by the user; message *requested reviewers* (Google Chat DM and/or WhatsApp) at the user's own identity until each reviews; show alerts in VS Code.

**Minimum viable setup (alerts only), in order:**
1. User creates a fine-grained GitHub PAT with read-only: Pull requests, Issues, Commit statuses, Checks.
2. Command `prReminder.setGitHubToken` ("PR Reminder: Set GitHub Personal Access Token").
3. Command `prReminder.setup` ("PR Reminder: Run Setup Wizard"). Only the GitHub username is mandatory.

**Add reviewer messaging:**
- Google Chat → needs Google Workspace (not consumer Gmail), Chat API enabled in a Google Cloud project, OAuth client type *Desktop app*, scopes `chat.spaces.readonly`, `chat.spaces.create`, `chat.messages.create`. Then command `prReminder.signInGoogle`; verify with `prReminder.testChat`. Client ID is stored in setting `prReminder.chat.googleClientId`; secret in Secret Storage.
- WhatsApp → `prReminder.linkWhatsApp` (QR scan), then `prReminder.testWhatsApp`. Needs a Chromium-based browser (optional override: `prReminder.whatsapp.chromePath`).
- Reviewer routing → setting `prReminder.reviewers` maps GitHub login → email (Chat); `prReminder.whatsapp.numbers` maps login → E.164 number (WhatsApp). Team reviewers are written `"@org/team-slug"` and must be mapped to one person.

**Key commands (all prefixed `prReminder.`):** `setup`, `setGitHubToken`, `signInGoogle`, `signInGoogleCustomClient`, `signOutGoogle`, `manageGoogleChat`, `testChat`, `linkWhatsApp`, `manageWhatsApp`, `testWhatsApp`, `unlinkWhatsApp`, `openDashboard`, `refresh`, `pause`, `resume`, `pausePr`, `resumePr`, `snooze`, `acknowledgeAll`, `toggleQuietMode`, `setReminderInterval`, `retryMessages`, `clearFailedMessages`, `restartService`, `showLogs`, `clearSecrets` ("Delete Stored Credentials"), `previewBigAlert`, `simulateAlerts`.

**Key settings:** `prReminder.github.username`, `.github.repositories` (array of `owner/name`; empty = all authored PRs), `.github.pollIntervalSeconds` (120), `.reminders.intervalMinutes` (30), `.reminders.maxRemindersPerReviewer` (5), `.reminders.quietHours.{enabled,start,end,quietDays}`, `.reminders.timeZone`, `.alerts.size` (`normal`|`big`), `.alerts.soundEnabled`, `.alerts.quietMode`, `.service.keepRunningWhenClosed`, `.service.mode` (`local`|`remote`).

**Behaviour rules to rely on:**
- First sync is a baseline: no alerts or initial DMs for pre-existing activity.
- A "response" = submitted review (APPROVED / CHANGES_REQUESTED / COMMENTED). Plain comments count only if `reminders.countCommentsAsResponse` is true.
- Reminders stop per reviewer on response/removal and for all on merge/close. Draft PRs are never messaged. Quiet hours defer messages, not drop them.
- Messages are deduplicated across restarts; an uncertain-delivery message is marked `failed` and is never auto-retried.
- Extension is read-only toward GitHub.

**Troubleshooting order for an assistant to suggest:** (1) `prReminder.showLogs`; (2) `prReminder.restartService`; (3) check token scope/repo access; (4) check reviewer mapping; (5) for Google errors map `invalid_client` → wrong/non-Desktop client, `admin_policy_enforced` → admin must allow client, `org_internal` → client belongs to another org, HTTP 403 → Chat API/Configuration page, 404 → email not a Workspace user.

**Do not:** ask the user to paste tokens into chat; suggest consumer Gmail for Chat; promise delivery while VS Code is closed unless `service.keepRunningWhenClosed` is on.

---

## Developers

Architecture, full configuration reference, service API, building, testing and packaging are documented in `docs/REFERENCE.md` in the source code folder. In short: `npm install && npm run check && npm run package`.

---

© 2026 Santhosh James C. Released under the MIT License.
