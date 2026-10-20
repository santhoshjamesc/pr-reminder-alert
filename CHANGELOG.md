# Changelog

## 0.2.0

- Beginner-friendly README with step-by-step setup, troubleshooting and an AI-assistant quick reference. The developer documentation moved to `docs/REFERENCE.md`.
- New "Get Started" walkthrough inside VS Code.
- Publishing metadata (author, publisher, categories, Marketplace banner).

- Extension icon: rounded white tile with a larger glyph, so it reads clearly on light and dark themes.
- New setting `prReminder.service.keepRunningWhenClosed` (off by default): keeps the local service, and so reviewer reminders, running after VS Code quits. The next window reconnects to it, and logs also go to `service.log` in global storage.
- PR Reminder now lives in the left Activity Bar instead of the bottom panel next to the Terminal.
- WhatsApp: fixed messages never sending ("still in the message box"). Send is pressed again if WhatsApp Web ignores it, and delivery is detected with its current markup.

- Google Chat OAuth client is configurable: new setting `prReminder.chat.googleClientId` (the secret stays in Secret Storage).
- Guided setup: signing in without a client explains the free, one-time Google Cloud steps and opens the console.
- New command "Sign in to Google Chat with Your Own OAuth Client…" to switch clients.
- Forks can bundle a default client at build time (`PR_REMINDER_GOOGLE_CLIENT_ID` / `PR_REMINDER_GOOGLE_CLIENT_SECRET`).
- Clearer messages for `org_internal` and `admin_policy_enforced` sign-in errors.
- Google sign-in checks the OAuth client before opening the browser and reports `invalid_client` right away, with a "Re-enter client…" button.
- Signing in again always shows Google's account chooser, so you can switch accounts.
- New "Manage Google Chat…" and "Manage WhatsApp…" menus (click the channel row or its ⚙ icon in Service & Warnings): test, sign in again / switch account, change OAuth client, sign out; link, re-link, unlink; turn on/off.
- New "Reviewer Messages" view: latest Chat and WhatsApp messages with their status (waiting, sending, sent, failed, cancelled), last error, and per-message retry. New API endpoint `GET /api/messages`.
- Test WhatsApp shows live progress (starting WhatsApp Web, opening the chat, sending, waiting for confirmation).
- WhatsApp delivery check looks at the new message's tick instead of any pending clock on the page. Messages queued in WhatsApp Web count as sent, and unconfirmed sends are no longer retried automatically (no duplicate reminders).

## 0.1.0

- Initial release: GitHub PR polling, per-reviewer Gmail reminders with persistent SQLite scheduler,
  quiet hours, pause/resume, alert styles (notification, banner, sound, status bar, repeat), dashboard,
  setup wizard, local and remote service modes.
