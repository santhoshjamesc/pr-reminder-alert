import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore } from '../../src/service/config/configStore';
import type { AppConfig } from '../../src/service/config/schema';
import { ChatNotifier } from '../../src/service/chat/chatClient';
import { MessageDispatcher } from '../../src/service/chat/dispatcher';
import { MessageComposer } from '../../src/service/core/messageComposer';
import { ReminderEngine } from '../../src/service/core/reminderEngine';
import { SyncEngine } from '../../src/service/core/syncEngine';
import { silentLogger } from '../../src/service/logging/logger';
import { Store } from '../../src/service/storage/store';
import { FakeGitHub, MockChatTransport, MockWhatsApp, makeConfig } from './fixtures';

export interface Harness {
  store: Store;
  github: FakeGitHub;
  transport: MockChatTransport;
  whatsapp: MockWhatsApp;
  config: AppConfig;
  sync: SyncEngine;
  reminders: ReminderEngine;
  dispatcher: MessageDispatcher;
  setConfig(config: AppConfig): void;
  /** Runs one sync followed by one reminder tick at `now`. */
  cycle(now: Date): Promise<void>;
  dbPath: string;
}

export function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-reminder-test-'));
  return path.join(dir, 'test.db');
}

export function createHarness(options: { config?: AppConfig; dbPath?: string; github?: FakeGitHub; transport?: MockChatTransport } = {}): Harness {
  const dbPath = options.dbPath ?? ':memory:';
  const store = new Store(dbPath);
  const github = options.github ?? new FakeGitHub();
  const transport = options.transport ?? new MockChatTransport();
  const configStore = new ConfigStore(null);
  configStore.update(options.config ?? makeConfig());
  const notifier = new ChatNotifier(transport, silentLogger, { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 }, async () => undefined);
  const composer = new MessageComposer(store);
  const whatsapp = new MockWhatsApp();
  const dispatcher = new MessageDispatcher(store, () => notifier, () => configStore.get(), silentLogger, () => whatsapp);
  const sync = new SyncEngine(store, () => github, () => configStore.get(), composer, silentLogger);
  const reminders = new ReminderEngine(store, composer, dispatcher, () => configStore.get(), silentLogger);
  const h: Harness = {
    store,
    github,
    transport,
    whatsapp,
    get config() {
      return configStore.get() as AppConfig;
    },
    sync,
    reminders,
    dispatcher,
    setConfig: (config) => configStore.update(config),
    cycle: async (now) => {
      await sync.sync(now);
      await reminders.tick(now);
    },
    dbPath,
  };
  return h;
}

export const minutes = (base: Date, m: number) => new Date(base.getTime() + m * 60_000);
