import * as os from 'node:os';
import { BUILD_ID } from '../shared/build';
import { maskEmail, maskPhone, safeErrorMessage } from '../shared/redact';
import type {
  DeliveryFailureDto,
  EventDto,
  MessageDto,
  PullRequestDto,
  ServiceStatusDto,
  TestChatResultDto,
  UnmappedReviewerDto,
} from '../shared/protocol';
import { type ChatTransport, ChatNotifier, GoogleChatTransport } from './chat/chatClient';
import { MessageDispatcher } from './chat/dispatcher';
import { GoogleTokenProvider } from './chat/googleAuth';
import type { ConfigStore } from './config/configStore';
import type { AppConfig, Secrets } from './config/schema';
import { ReminderEngine } from './core/reminderEngine';
import { MessageComposer } from './core/messageComposer';
import { emailFor, hasMapping, phoneFor } from './core/reviewerReconciler';
import { SyncEngine } from './core/syncEngine';
import { OctokitGateway } from './github/octokitGateway';
import type { GitHubGateway } from './github/types';
import type { Logger } from './logging/logger';
import type { EventRow } from './storage/eventRepository';
import type { PrRow } from './storage/prRepository';
import { KV_KEYS, type Store } from './storage/store';
import { type WhatsAppTransport, WhatsAppWebTransport } from './whatsapp/whatsappWeb';

export const SERVICE_VERSION = '0.1.0';

export interface ServiceDeps {
  store: Store;
  configStore: ConfigStore;
  secrets: Secrets;
  logger: Logger;
  /** Overrides for tests. */
  gatewayFactory?: (config: AppConfig, token: string) => GitHubGateway;
  chatTransportFactory?: (secrets: Secrets) => ChatTransport;
  whatsapp?: WhatsAppTransport;
  /** Where the WhatsApp browser profile is kept (defaults to the system temp dir). */
  dataDir?: string;
  reminderTickMs?: number;
}

/**
 * Composition root of the notification service: wires storage, GitHub,
 * email, sync and reminder engines together and runs the polling loops.
 */
/**
 * Whether a PR still belongs in the PR list. Merged/closed PRs drop out `hideAfterDays`
 * after they merged or closed. Their rows are kept so a later sync never re-alerts on them.
 */
export function isListedPr(pr: Pick<PrRow, 'state' | 'merged_at' | 'closed_at' | 'updated_at'>, hideAfterDays: number, now: Date): boolean {
  if (pr.state === 'open') {
    return true;
  }
  const endedAt = Date.parse(pr.merged_at ?? pr.closed_at ?? pr.updated_at);
  return now.getTime() - endedAt < hideAfterDays * 86_400_000;
}

export class NotificationService {
  readonly store: Store;
  readonly sync: SyncEngine;
  readonly reminders: ReminderEngine;
  private readonly configStore: ConfigStore;
  private readonly secrets: Secrets;
  private readonly logger: Logger;
  private readonly gatewayFactory: (config: AppConfig, token: string) => GitHubGateway;
  private readonly chatTransportFactory: (secrets: Secrets) => ChatTransport;
  private gateway: GitHubGateway | null = null;
  private notifier: ChatNotifier | null = null;
  private readonly whatsapp: WhatsAppTransport;
  private readonly startedAt = new Date();
  private syncTimer: NodeJS.Timeout | null = null;
  private reminderTimer: NodeJS.Timeout | null = null;
  private nextSyncAt: Date | null = null;
  private stopped = false;
  private consecutiveSyncFailures = 0;
  private readonly reminderTickMs: number;
  private stopHandlers: Array<() => Promise<void> | void> = [];

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.configStore = deps.configStore;
    this.secrets = deps.secrets;
    this.logger = deps.logger;
    this.reminderTickMs = deps.reminderTickMs ?? 30_000;
    this.gatewayFactory =
      deps.gatewayFactory ??
      ((config, token) => new OctokitGateway({ token, baseUrl: config.github.apiBaseUrl, logger: this.logger }));
    this.chatTransportFactory =
      deps.chatTransportFactory ??
      ((s) =>
        new GoogleChatTransport(
          new GoogleTokenProvider({ clientId: s.googleClientId ?? '', clientSecret: s.googleClientSecret ?? '', refreshToken: s.googleRefreshToken ?? '' }),
        ));

    this.whatsapp =
      deps.whatsapp ??
      new WhatsAppWebTransport(deps.dataDir ?? os.tmpdir(), this.configStore.get()?.whatsapp.chromePath ?? '', this.logger.child({ component: 'whatsapp' }));
    this.stopHandlers.push(() => this.whatsapp.close());

    const composer = new MessageComposer(this.store);
    const dispatcher = new MessageDispatcher(
      this.store,
      () => this.notifier,
      () => this.configStore.get(),
      this.logger.child({ component: 'messages' }),
      () => this.whatsapp,
    );
    this.sync = new SyncEngine(this.store, () => this.gateway, () => this.configStore.get(), composer, this.logger.child({ component: 'sync' }));
    this.reminders = new ReminderEngine(this.store, composer, dispatcher, () => this.configStore.get(), this.logger.child({ component: 'reminders' }));

    this.rebuildClients(this.configStore.get());
    this.configStore.onChange((config) => {
      this.rebuildClients(config);
      this.scheduleSync(1000);
    });
  }

  private rebuildClients(config: AppConfig | null): void {
    if (this.whatsapp instanceof WhatsAppWebTransport) {
      this.whatsapp.setChromePath(config?.whatsapp.chromePath ?? '');
    }
    this.gateway = config && this.secrets.githubToken ? this.gatewayFactory(config, this.secrets.githubToken) : null;
    const { googleClientId, googleClientSecret, googleRefreshToken } = this.secrets;
    this.notifier =
      config && googleClientId && googleClientSecret && googleRefreshToken
        ? new ChatNotifier(this.chatTransportFactory(this.secrets), this.logger.child({ component: 'chat' }))
        : null;
  }

  onStop(handler: () => Promise<void> | void): void {
    this.stopHandlers.push(handler);
  }

  /** Starts polling and the reminder loop. Recovers state left by a crash first. */
  start(): void {
    const recovered = this.store.outbox.recoverInterrupted();
    if (recovered > 0) {
      this.logger.warn('Recovered Chat messages interrupted by a previous crash', { count: recovered });
    }
    this.scheduleSync(0);
    this.reminderTimer = setInterval(() => void this.runReminderTick(), this.reminderTickMs);
    this.reminderTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer);
    }
    for (const handler of this.stopHandlers) {
      await handler();
    }
    this.store.close();
    this.logger.info('Service stopped');
  }

  private scheduleSync(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.nextSyncAt = new Date(Date.now() + delayMs);
    this.syncTimer = setTimeout(() => void this.runSyncLoop(), delayMs);
  }

  private async runSyncLoop(): Promise<void> {
    const config = this.configStore.get();
    let delay = (config?.github.pollIntervalSeconds ?? 120) * 1000;
    try {
      const result = await this.sync.sync();
      if (result.errors.length > 0 && result.prsSynced === 0) {
        this.consecutiveSyncFailures++;
        // Exponential backoff on outages, capped at 30 minutes; honour GitHub's retry-after.
        delay = Math.max(delay, Math.min(delay * 2 ** Math.min(this.consecutiveSyncFailures, 5), 30 * 60_000));
      } else {
        this.consecutiveSyncFailures = 0;
      }
      if (result.retryAfterMs) {
        delay = Math.max(delay, result.retryAfterMs);
      }
      const rate = this.gateway?.rateLimit();
      if (rate?.remaining !== null && rate?.remaining !== undefined && rate.remaining < 100 && rate.resetAt) {
        delay = Math.max(delay, Date.parse(rate.resetAt) - Date.now());
      }
      if (result.prsSynced > 0) {
        await this.runReminderTick();
      }
    } catch (error) {
      this.logger.error('Sync loop error', { error: safeErrorMessage(error) });
    } finally {
      this.scheduleSync(delay);
    }
  }

  private async runReminderTick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      await this.reminders.tick();
    } catch (error) {
      this.logger.error('Reminder tick failed', { error: safeErrorMessage(error) });
    }
  }

  // ---- API operations -------------------------------------------------------

  status(): ServiceStatusDto {
    const kv = this.store.kv;
    const rate = this.gateway?.rateLimit() ?? { remaining: null, limit: null, resetAt: null };
    return {
      version: SERVICE_VERSION,
      build: BUILD_ID,
      startedAt: this.startedAt.toISOString(),
      githubConfigured: this.gateway !== null,
      chatConfigured: this.notifier !== null,
      whatsappEnabled: this.configStore.get()?.whatsapp.enabled ?? false,
      whatsappLinked: this.whatsapp.isLinked(),
      whatsappError: this.whatsapp.lastError(),
      whatsappActivity: this.whatsapp.activity(),
      githubUser: this.configStore.get()?.github.username ?? null,
      globalPaused: kv.getBool(KV_KEYS.globalPaused),
      baselineComplete: kv.getBool(KV_KEYS.baselineComplete),
      lastSyncAt: kv.get(KV_KEYS.lastSyncAt),
      lastSyncError: kv.get(KV_KEYS.lastSyncError),
      nextSyncAt: this.nextSyncAt?.toISOString() ?? null,
      rateLimit: rate,
      pendingMessages: this.store.outbox.count('queued'),
      failedMessages: this.store.outbox.count('failed'),
      unacknowledgedAlerts: this.store.events.countUnacknowledged(),
    };
  }

  listPullRequests(now = new Date()): PullRequestDto[] {
    const config = this.configStore.get();
    const hideAfterDays = config?.github.hideClosedPrsAfterDays ?? 7;
    return this.store.prs.list().filter((pr) => isListedPr(pr, hideAfterDays, now)).map((pr) => {
      const reviewers = this.store.reviewers.listForPr(pr.pr_key).map((r) => {
        const email = config ? emailFor(r.login, config) : null;
        const phone = config ? phoneFor(r.login, config) : null;
        return {
          login: r.display_login,
          kind: r.kind,
          status: r.status,
          reviewState: r.review_state,
          mapped: config ? hasMapping(r.login, config) : false,
          maskedEmail: email ? maskEmail(email) : null,
          maskedPhone: phone ? maskPhone(phone) : null,
          reminderCount: r.reminder_count,
          lastNotifiedAt: r.last_notified_at,
          nextReminderAt: pr.state === 'open' ? r.next_reminder_at : null,
        };
      });
      const max = (values: (string | null)[]) => values.filter((v): v is string => v !== null).sort().at(-1) ?? null;
      const min = (values: (string | null)[]) => values.filter((v): v is string => v !== null).sort()[0] ?? null;
      return {
        key: pr.pr_key,
        repo: pr.repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        draft: pr.draft === 1,
        author: pr.author,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        paused: pr.paused === 1,
        ciState: pr.ci_state,
        headSha: pr.head_sha,
        reviewers,
        lastNotifiedAt: max(reviewers.map((r) => r.lastNotifiedAt)),
        nextReminderAt: min(reviewers.filter((r) => r.status === 'pending').map((r) => r.nextReminderAt)),
      };
    });
  }

  listEvents(sinceId: number, limit: number, includeHistorical: boolean): EventDto[] {
    const prs = new Map(this.store.prs.list().map((p) => [p.pr_key, p]));
    return this.store.events.list({ sinceId, limit, includeHistorical }).map((e) => toEventDto(e, prs.get(e.pr_key)?.title ?? ''));
  }

  listUnmapped(): UnmappedReviewerDto[] {
    const config = this.configStore.get();
    const out = new Map<string, UnmappedReviewerDto>();
    for (const r of this.store.reviewers.listAllPending()) {
      if (config && hasMapping(r.login, config)) {
        continue;
      }
      const entry = out.get(r.login) ?? { login: r.display_login, kind: r.kind, prKeys: [] };
      entry.prKeys.push(r.pr_key);
      out.set(r.login, entry);
    }
    return [...out.values()];
  }

  listFailedMessages(): DeliveryFailureDto[] {
    return this.store.outbox.list('failed').map((row) => ({
      id: row.id,
      kind: row.kind,
      channel: row.channel,
      prKey: row.pr_key,
      recipient: row.channel === 'whatsapp' ? maskPhone(row.recipient) : maskEmail(row.recipient),
      attempts: row.attempts,
      lastError: row.last_error,
      status: row.status,
    }));
  }

  listMessages(limit: number): MessageDto[] {
    return this.store.outbox.list(undefined, limit).map((row) => ({
      id: row.id,
      kind: row.kind,
      channel: row.channel,
      prKey: row.pr_key,
      reviewer: row.reviewer_login,
      recipient: row.channel === 'whatsapp' ? maskPhone(row.recipient) : maskEmail(row.recipient),
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
      sentAt: row.sent_at,
      nextAttemptAt: row.next_attempt_at,
    }));
  }

  async syncNow(): Promise<{ prsSynced: number; newEvents: number; errors: string[] }> {
    const result = await this.sync.sync();
    await this.runReminderTick();
    this.scheduleSync((this.configStore.get()?.github.pollIntervalSeconds ?? 120) * 1000);
    return { prsSynced: result.prsSynced, newEvents: result.newEvents.length, errors: result.errors };
  }

  setPaused(paused: boolean, prKey?: string): { ok: boolean } {
    if (prKey) {
      return { ok: this.store.prs.setPaused(prKey, paused) };
    }
    this.store.kv.set(KV_KEYS.globalPaused, paused ? 'true' : 'false');
    return { ok: true };
  }

  acknowledge(ids: number[] | 'all'): { acknowledged: number } {
    return { acknowledged: this.store.events.acknowledge(ids, new Date()) };
  }

  retryFailedMessages(ids: number[] | 'all'): { requeued: number } {
    const requeued = this.store.outbox.requeueFailed(ids, new Date());
    void this.runReminderTick();
    return { requeued };
  }

  clearFailedMessages(ids: number[] | 'all'): { cleared: number } {
    return { cleared: this.store.outbox.dismissFailed(ids) };
  }

  /** Verifies Google sign-in; with `reviewer`, also sends a test DM to that mapped reviewer. */
  async testChat(reviewer?: string): Promise<TestChatResultDto> {
    if (!this.notifier) {
      return { ok: false, message: 'Google Chat is not configured: run "PR Reminder: Sign in to Google Chat" (or set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN).' };
    }
    const verified = await this.notifier.verify();
    if (!verified.ok || !reviewer) {
      return verified;
    }
    const config = this.configStore.get();
    const email = config ? emailFor(reviewer, config) : null;
    if (!email) {
      return { ok: false, message: `No Workspace email mapped for ${reviewer}.` };
    }
    try {
      const space = await this.notifier.findOrCreateDm(email);
      this.store.chatSpaces.set(email, space);
      await this.notifier.send(space, '🔔 Test message from PR Reminder. You will get pull request review reminders in this chat.');
      return { ok: true, message: `Test DM sent to ${maskEmail(email)}.` };
    } catch (error) {
      return { ok: false, message: safeErrorMessage(error) };
    }
  }

  /** Reports whether WhatsApp is linked; with `reviewer`, also sends a test message to that reviewer's mapped number. */
  async testWhatsApp(reviewer?: string): Promise<TestChatResultDto> {
    const config = this.configStore.get();
    if (!this.whatsapp.isLinked()) {
      return { ok: false, message: 'WhatsApp is not linked: run "PR Reminder: Link WhatsApp" and scan the QR code with your phone.' };
    }
    if (!reviewer) {
      return { ok: true, message: config?.whatsapp.enabled ? 'WhatsApp is linked and enabled.' : 'WhatsApp is linked, but disabled in settings (prReminder.whatsapp.enabled).' };
    }
    const phone = config ? phoneFor(reviewer, config) : null;
    if (!phone) {
      return { ok: false, message: `No WhatsApp number mapped for ${reviewer}.` };
    }
    try {
      await this.whatsapp.send(phone, '🔔 Test message from PR Reminder. You will get pull request review reminders here.');
      return { ok: true, message: `Test WhatsApp message sent to ${maskPhone(phone)}.` };
    } catch (error) {
      return { ok: false, message: safeErrorMessage(error) };
    }
  }

  /** Opens a browser window with the WhatsApp Web QR code; resolves when linked. */
  async linkWhatsApp(): Promise<TestChatResultDto> {
    try {
      await this.whatsapp.link();
      void this.runReminderTick(); // send anything that was waiting for WhatsApp
      return { ok: true, message: 'WhatsApp linked. Reviewer messages will be sent from your WhatsApp account.' };
    } catch (error) {
      return { ok: false, message: safeErrorMessage(error) };
    }
  }

  async unlinkWhatsApp(): Promise<{ ok: true }> {
    await this.whatsapp.unlink();
    return { ok: true };
  }

  updateConfig(raw: unknown): { ok: true } {
    this.configStore.update(raw);
    return { ok: true };
  }
}

export function toEventDto(e: EventRow, prTitle: string): EventDto {
  const [repo, num] = e.pr_key.split('#');
  return {
    id: e.id,
    key: e.event_key,
    prKey: e.pr_key,
    repo: repo ?? '',
    number: Number(num),
    prTitle,
    type: e.type,
    severity: e.severity,
    summary: e.summary,
    url: e.url,
    actor: e.actor,
    occurredAt: e.occurred_at,
    recordedAt: e.recorded_at,
    historical: e.historical === 1,
    acknowledged: e.acknowledged_at !== null,
  };
}
