import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { safeErrorMessage } from '../../shared/redact';
import type { Logger } from '../logging/logger';

const WHATSAPP_URL = 'https://web.whatsapp.com/';

/** The only browser global used, inside page.evaluate callbacks (they run in WhatsApp Web, not in Node). */
interface DomNode {
  textContent: string | null;
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
}
declare const document: DomNode;

/** WhatsApp Web changes its markup now and then, so every lookup tries several selectors. */
const SELECTORS = {
  loggedIn: ['#pane-side', '#side', '[aria-label="Chat list"]', '[data-testid="chat-list"]'],
  qr: ['canvas[aria-label*="scan" i]', 'div[data-ref] canvas', '[data-testid="qrcode"]', 'div[data-ref]'],
  compose: [
    'footer div[contenteditable="true"]',
    'footer div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][data-lexical-editor="true"]',
    'div[contenteditable="true"][data-tab="10"]',
    'div[aria-label="Type a message"]',
  ],
  send: ['button[aria-label="Send"]', 'span[data-icon="send"]', 'span[data-icon="wds-ic-send-filled"]'],
  // Older markup used div.message-out and data-icon ticks; newer markup only labels the tick of outgoing messages.
  outgoing: ['div.message-out', 'div[data-testid="msg-container"]:has([data-testid="msg-meta"] span[aria-label])'],
  pendingTick: ['span[data-icon="msg-time"]', '[data-testid="msg-meta"] span[aria-label*="pending" i]'],
  sentTick: [
    'span[data-icon="msg-check"]',
    'span[data-icon="msg-dblcheck"]',
    'span[data-icon="msg-dblcheck-ack"]',
    '[data-testid="msg-meta"] span[aria-label*="sent" i]',
    '[data-testid="msg-meta"] span[aria-label*="delivered" i]',
    '[data-testid="msg-meta"] span[aria-label*="read" i]',
  ],
};

/** What the chat looks like while waiting for a sent message to be acknowledged. */
export interface DeliverySnapshot {
  /** A compose box was found. */
  composeFound: boolean;
  /** Characters left in the compose box (zero-width characters ignored). */
  composeText: number;
  /** Outgoing message bubbles before and after pressing send. */
  outgoingBefore: number;
  outgoingNow: number;
  /** The newest outgoing bubble shows a sent/delivered tick, or still the "pending" clock. */
  lastSent: boolean;
  lastPending: boolean;
  /** A "pending" clock anywhere in the chat. */
  anyPending: boolean;
}

/**
 * sent: WhatsApp acknowledged the message. queued: a new bubble is waiting to
 * go out (WhatsApp will send it). notSent: the text is still in the box.
 * unknown: nothing conclusive, so the message may or may not have gone out.
 */
export type DeliveryState = 'sent' | 'queued' | 'notSent' | 'unknown';

export function classifyDelivery(s: DeliverySnapshot): DeliveryState {
  if (s.outgoingNow > s.outgoingBefore) {
    return s.lastSent && !s.lastPending ? 'sent' : 'queued';
  }
  if (s.composeFound && s.composeText > 0) {
    return 'notSent';
  }
  // Bubble selectors found nothing at all (markup changed): fall back to "box emptied and nothing pending".
  if (s.outgoingNow === 0 && s.composeFound && !s.anyPending) {
    return 'sent';
  }
  return 'unknown';
}

export class WhatsAppError extends Error {
  constructor(
    message: string,
    /** Retry later (timeouts, page not loading). */
    readonly transient: boolean,
    /** WhatsApp is not usable right now (not linked, no browser): keep messages queued instead of failing them. */
    readonly unavailable = false,
  ) {
    super(message);
    this.name = 'WhatsAppError';
  }
}

/** Minimal WhatsApp contract (implemented by WhatsAppWebTransport and by test mocks). */
export interface WhatsAppTransport {
  /** True once a WhatsApp account has been linked by scanning the QR code. */
  isLinked(): boolean;
  /** Last problem that makes WhatsApp unusable (e.g. browser not found), or null. */
  lastError(): string | null;
  /** What the transport is doing right now, for progress display; null when idle. */
  activity(): string | null;
  /** Sends `text` to `phone` (digits with country code). */
  send(phone: string, text: string): Promise<void>;
  /** Opens a visible browser window with the QR code and resolves once the phone has linked it. */
  link(timeoutMs?: number): Promise<void>;
  /** Forgets the linked account (deletes the browser profile). */
  unlink(): Promise<void>;
  close(): Promise<void>;
}

/** Well-known Chrome/Chromium/Edge/Brave install locations. */
export function browserCandidates(platform = process.platform, env = process.env): string[] {
  if (platform === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
    return apps.flatMap((a) => [path.join('/Applications', a), path.join(os.homedir(), 'Applications', a)]);
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string => Boolean(r));
    const exes = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'];
    return roots.flatMap((r) => exes.map((e) => path.win32.join(r, e)));
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'].map((b) => path.join('/usr/bin', b));
}

export function findBrowser(configured: string, exists: (p: string) => boolean = fs.existsSync): string | null {
  if (configured) {
    return exists(configured) ? configured : null;
  }
  return browserCandidates().find((p) => exists(p)) ?? null;
}

interface PageState {
  state: 'qr' | 'invalid' | 'ready' | 'loggedIn' | 'loading';
  composeText: number;
}

/**
 * Sends WhatsApp messages from the user's own account by driving WhatsApp Web
 * (like pywhatkit) in a dedicated Chrome profile. The profile is linked once
 * by scanning a QR code; after that the browser runs headless in the
 * background and never touches the user's keyboard, mouse or normal browser.
 * All browser work is serialised because a profile can only be open once.
 */
export class WhatsAppWebTransport implements WhatsAppTransport {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private problem: string | null = null;
  private step: string | null = null;
  private readonly profileDir: string;
  private readonly markerFile: string;

  constructor(
    dataDir: string,
    private chromePath: string,
    private readonly logger: Logger,
    private readonly options: { pageTimeoutMs?: number; idleCloseMs?: number } = {},
  ) {
    this.profileDir = path.join(dataDir, 'whatsapp-profile');
    this.markerFile = path.join(dataDir, 'whatsapp-linked.json');
  }

  setChromePath(chromePath: string): void {
    this.chromePath = chromePath;
  }

  isLinked(): boolean {
    return fs.existsSync(this.markerFile);
  }

  lastError(): string | null {
    return this.problem;
  }

  activity(): string | null {
    return this.step;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async launch(headless: boolean): Promise<Browser> {
    const executablePath = findBrowser(this.chromePath);
    if (!executablePath) {
      this.problem = this.chromePath
        ? `Browser not found at ${this.chromePath} (prReminder.whatsapp.chromePath)`
        : 'Google Chrome, Chromium, Edge or Brave is required for WhatsApp and was not found. Install Chrome or set prReminder.whatsapp.chromePath.';
      throw new WhatsAppError(this.problem, false, true);
    }
    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    const { default: puppeteer } = await import('puppeteer-core');
    try {
      const browser = await puppeteer.launch({
        executablePath,
        headless,
        userDataDir: this.profileDir,
        defaultViewport: headless ? { width: 1280, height: 900 } : null,
        args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', ...(headless ? [] : ['--window-size=1000,800'])],
      });
      this.problem = null;
      return browser;
    } catch (error) {
      const message = safeErrorMessage(error);
      if (/already running|SingletonLock|ProcessSingleton/i.test(message)) {
        throw new WhatsAppError('The WhatsApp browser profile is in use (a linking window may still be open). Close it and try again.', true);
      }
      this.problem = `Could not start the browser for WhatsApp: ${message}`;
      throw new WhatsAppError(this.problem, true, true);
    }
  }

  private async closeBrowser(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    await browser?.close().catch(() => undefined);
  }

  /** Headless page reused across sends; closed after a quiet period. */
  private async headlessPage(): Promise<Page> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.page && !this.page.isClosed() && this.browser?.connected) {
      return this.page;
    }
    await this.closeBrowser();
    this.browser = await this.launch(true);
    const page = (await this.browser.pages())[0] ?? (await this.browser.newPage());
    // WhatsApp Web refuses "HeadlessChrome" user agents.
    const ua = (await this.browser.userAgent()).replace(/HeadlessChrome/g, 'Chrome');
    await page.setUserAgent({ userAgent: ua });
    this.page = page;
    return page;
  }

  private scheduleIdleClose(): void {
    this.idleTimer = setTimeout(() => void this.exclusive(() => this.closeBrowser()), this.options.idleCloseMs ?? 90_000);
    this.idleTimer.unref?.();
  }

  private readState(page: Page): Promise<PageState> {
    return page.evaluate((sel: typeof SELECTORS) => {
      const any = (list: string[]) => list.map((s) => document.querySelector(s)).find((el) => el !== null) ?? null;
      const dialog = document.querySelector('div[role="dialog"], [data-animate-modal-popup="true"]');
      if (dialog && /invalid|not on whatsapp|isn.t on whatsapp/i.test(dialog.textContent ?? '')) {
        return { state: 'invalid' as const, composeText: 0 };
      }
      const compose = any(sel.compose);
      if (compose) {
        return { state: 'ready' as const, composeText: (compose.textContent ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().length };
      }
      if (any(sel.qr)) {
        return { state: 'qr' as const, composeText: 0 };
      }
      if (any(sel.loggedIn)) {
        return { state: 'loggedIn' as const, composeText: 0 };
      }
      return { state: 'loading' as const, composeText: 0 };
    }, SELECTORS);
  }

  send(phone: string, text: string): Promise<void> {
    if (!/^[1-9]\d{7,14}$/.test(phone)) {
      return Promise.reject(new WhatsAppError('Invalid phone number', false));
    }
    if (!this.isLinked()) {
      return Promise.reject(new WhatsAppError('WhatsApp is not linked. Run "PR Reminder: Link WhatsApp".', false, true));
    }
    return this.exclusive(async () => {
      try {
        this.step = 'Starting WhatsApp Web…';
        await this.sendOnce(phone, text);
      } catch (error) {
        // A broken page is not reused for the next message.
        await this.closeBrowser();
        if (error instanceof WhatsAppError) {
          throw error;
        }
        throw new WhatsAppError(`WhatsApp Web error: ${safeErrorMessage(error)}`, true);
      } finally {
        this.step = null;
        if (this.browser) {
          this.scheduleIdleClose();
        }
      }
    });
  }

  private async sendOnce(phone: string, text: string): Promise<void> {
    const page = await this.headlessPage();
    const timeout = this.options.pageTimeoutMs ?? 60_000;
    this.step = `Opening the chat with +${phone.slice(0, 2)}******${phone.slice(-4)}…`;
    await page.goto(`${WHATSAPP_URL}send?phone=${phone}&text=${encodeURIComponent(text)}`, { waitUntil: 'domcontentloaded', timeout });

    const deadline = Date.now() + timeout;
    let readySince: number | null = null;
    for (;;) {
      if (Date.now() > deadline) {
        throw new WhatsAppError('WhatsApp Web did not open the chat in time', true);
      }
      const s = await this.readState(page).catch((): PageState => ({ state: 'loading', composeText: 0 }));
      if (s.state === 'qr') {
        fs.rmSync(this.markerFile, { force: true });
        throw new WhatsAppError('WhatsApp was logged out on this computer. Run "PR Reminder: Link WhatsApp" and scan the QR code again.', false, true);
      }
      if (s.state === 'invalid') {
        throw new WhatsAppError(`+${phone} is not a valid WhatsApp number`, false);
      }
      if (s.state === 'ready') {
        readySince ??= Date.now();
        if (s.composeText > 0) {
          break;
        }
        if (Date.now() - readySince > 5000) {
          // Text was not pre-filled from the link: type it (Shift+Enter keeps line breaks inside one message).
          this.step = 'Typing the message…';
          await this.typeMessage(page, text);
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    this.step = 'Sending…';
    const outgoingBefore = await this.snapshot(page, 0).then((snap) => snap?.outgoingNow ?? 0);
    await this.pressSend(page);
    await this.waitDelivered(page, Math.min(30_000, timeout), outgoingBefore);
  }

  /**
   * WhatsApp Web ignores a send that lands right after the chat opens, so let
   * it settle and press send again while the text is still in the box. Text
   * left in the box means nothing went out, so pressing again cannot duplicate.
   */
  private async pressSend(page: Page): Promise<void> {
    await new Promise((r) => setTimeout(r, 1500));
    for (let attempt = 0; attempt < 4; attempt++) {
      const sendButton = await this.first(page, SELECTORS.send);
      if (sendButton) {
        await sendButton.click();
      } else {
        await (await this.first(page, SELECTORS.compose))?.focus();
        await page.keyboard.press('Enter');
      }
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const s = await this.readState(page).catch(() => null);
        if (s?.state !== 'ready' || s.composeText === 0) {
          return;
        }
      }
      this.logger.debug('WhatsApp Web ignored the send, pressing it again', { attempt: attempt + 1 });
    }
  }

  private async typeMessage(page: Page, text: string): Promise<void> {
    const box = await this.first(page, SELECTORS.compose);
    if (!box) {
      throw new WhatsAppError('Message box not found on WhatsApp Web', true);
    }
    await box.click();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      await page.keyboard.type(lines[i] ?? '');
      if (i < lines.length - 1) {
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
      }
    }
  }

  private snapshot(page: Page, outgoingBefore: number): Promise<DeliverySnapshot | null> {
    return page
      .evaluate(
        (sel: typeof SELECTORS, before: number) => {
          const all = (list: string[], root: DomNode = document) => list.flatMap((s) => Array.from(root.querySelectorAll(s)));
          const compose = sel.compose.map((s) => document.querySelector(s)).find((el) => el !== null);
          const bubbles = all(sel.outgoing);
          const last = bubbles[bubbles.length - 1];
          return {
            composeFound: Boolean(compose),
            composeText: (compose?.textContent ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().length,
            outgoingBefore: before,
            outgoingNow: bubbles.length,
            lastSent: last ? all(sel.sentTick, last).length > 0 : false,
            lastPending: last ? all(sel.pendingTick, last).length > 0 : false,
            anyPending: all(sel.pendingTick).length > 0,
          };
        },
        SELECTORS,
        outgoingBefore,
      )
      .catch(() => null);
  }

  /**
   * Waits for WhatsApp to acknowledge the new outgoing message. A message that
   * is visibly queued counts as sent (WhatsApp sends it on its own); only a
   * message that is certainly not sent is retried, so reminders never go out twice.
   */
  private async waitDelivered(page: Page, timeoutMs: number, outgoingBefore: number): Promise<void> {
    this.step = 'Waiting for WhatsApp to confirm delivery…';
    const deadline = Date.now() + timeoutMs;
    let last: DeliverySnapshot | null = null;
    while (Date.now() < deadline) {
      last = (await this.snapshot(page, outgoingBefore)) ?? last;
      if (last && classifyDelivery(last) === 'sent') {
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const state = last ? classifyDelivery(last) : 'unknown';
    this.logger.debug('WhatsApp delivery check timed out', { state, ...(last ?? {}) });
    if (state === 'sent') {
      return;
    }
    if (state === 'queued') {
      this.logger.warn('WhatsApp message is queued on WhatsApp Web but not yet acknowledged; it will be sent when WhatsApp catches up');
      return;
    }
    if (state === 'notSent') {
      throw new WhatsAppError('WhatsApp Web did not send the message (it is still in the message box)', true);
    }
    // Not retried: the message may already have gone out, and a retry would send it twice.
    throw new WhatsAppError('WhatsApp did not confirm the message was sent (it may still go out). Check the chat on your phone.', false);
  }

  private async first(page: Page, selectors: string[]) {
    for (const s of selectors) {
      const el = await page.$(s);
      if (el) {
        return el;
      }
    }
    return null;
  }

  link(timeoutMs = 180_000): Promise<void> {
    return this.exclusive(async () => {
      await this.closeBrowser();
      const browser = await this.launch(false);
      try {
        const page = (await browser.pages())[0] ?? (await browser.newPage());
        await page.goto(WHATSAPP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        const deadline = Date.now() + timeoutMs;
        let seen = 0;
        while (Date.now() < deadline) {
          if (!browser.connected || page.isClosed()) {
            throw new WhatsAppError('The WhatsApp window was closed before linking finished', false);
          }
          const s = await this.readState(page).catch((): PageState => ({ state: 'loading', composeText: 0 }));
          // Require the chat list twice in a row so a half-loaded page is not mistaken for success.
          seen = s.state === 'loggedIn' ? seen + 1 : 0;
          if (seen >= 2) {
            // Give WhatsApp a moment to persist the session before closing the profile.
            await new Promise((r) => setTimeout(r, 5000));
            fs.writeFileSync(this.markerFile, JSON.stringify({ linkedAt: new Date().toISOString() }), { mode: 0o600 });
            this.logger.info('WhatsApp linked');
            return;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        throw new WhatsAppError('Timed out waiting for the QR code to be scanned', false);
      } finally {
        await browser.close().catch(() => undefined);
      }
    });
  }

  unlink(): Promise<void> {
    return this.exclusive(async () => {
      await this.closeBrowser();
      fs.rmSync(this.markerFile, { force: true });
      fs.rmSync(this.profileDir, { recursive: true, force: true });
    });
  }

  close(): Promise<void> {
    return this.exclusive(() => this.closeBrowser());
  }
}
