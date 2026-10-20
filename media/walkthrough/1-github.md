# Step 1: Give it a GitHub token

A **token** is a long password-like text that lets this extension *read* your pull requests. It cannot change or merge anything.

1. Open <https://github.com/settings/personal-access-tokens/new>
2. **Token name:** `PR Reminder`. **Expiration:** pick 90 days (you can renew later).
3. **Repository access:** choose *Only select repositories* and tick the repos you want watched.
4. Under **Repository permissions**, set these to **Read-only**: *Pull requests*, *Issues*, *Commit statuses*, *Checks*.
5. Click **Generate token** and **copy it now** (GitHub shows it only once).
6. Click **Set GitHub token** on the left and paste it.

Your token is stored in your computer's keychain, never in a file.
