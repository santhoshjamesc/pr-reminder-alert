/**
 * Notification service entry point.
 *
 * Local mode: started by the VS Code extension (secrets passed via env, port 0,
 * reports its port on stdout as `PR_REMINDER_READY <port>`).
 * Standalone mode: `npm run service` with a .env file (see .env.example), e.g.
 * on an always-on machine. The service keeps running independently of VS Code.
 * Detached local mode (prReminder.service.keepRunningWhenClosed): started by the
 * extension but outlives VS Code; logs are also appended to PR_REMINDER_LOG_FILE.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ZodError } from 'zod';
import { registerSecret, safeErrorMessage } from '../shared/redact';
import { ApiServer } from './api/server';
import { ConfigStore, formatZodError } from './config/configStore';
import { readSecrets } from './config/schema';
import { type LogLevel, createLogger } from './logging/logger';
import { NotificationService } from './service';
import { Store } from './storage/store';

function loadDotEnv(): void {
  const file = path.resolve(process.env.PR_REMINDER_ENV_FILE ?? '.env');
  if (fs.existsSync(file) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(file);
  }
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Log sink: stderr (read by the extension while it is open) plus an optional file kept for after VS Code quits. */
function createSink(logFile: string | undefined): (line: string) => void {
  let stream: fs.WriteStream | null = null;
  if (logFile) {
    try {
      if (fs.statSync(logFile).size > MAX_LOG_BYTES) {
        fs.renameSync(logFile, `${logFile}.1`);
      }
    } catch {
      // no log file yet
    }
    stream = fs.createWriteStream(logFile, { flags: 'a', mode: 0o600 });
    stream.on('error', () => {
      stream = null;
    });
  }
  return (line) => {
    process.stderr.write(`${line}\n`);
    stream?.write(`${line}\n`);
  };
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

async function main(): Promise<void> {
  loadDotEnv();
  // A detached service keeps running after VS Code closes its end of stdout/stderr; ignore EPIPE.
  process.stdout.on('error', () => undefined);
  process.stderr.on('error', () => undefined);
  const logger = createLogger({
    level: (process.env.PR_REMINDER_LOG_LEVEL as LogLevel | undefined) ?? 'info',
    sink: createSink(process.env.PR_REMINDER_LOG_FILE),
    bindings: { svc: 'pr-reminder' },
  });

  let secrets;
  try {
    secrets = readSecrets(process.env);
  } catch (error) {
    logger.error('Invalid secrets configuration', { error: error instanceof ZodError ? formatZodError(error) : safeErrorMessage(error) });
    process.exit(2);
  }
  for (const value of [secrets.githubToken, secrets.googleClientSecret, secrets.googleRefreshToken, secrets.apiToken]) {
    registerSecret(value);
  }
  // Secrets are no longer needed in the environment once read.
  for (const key of ['GITHUB_TOKEN', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'PR_REMINDER_API_TOKEN']) {
    delete process.env[key];
  }

  const dataDir = path.resolve(process.env.PR_REMINDER_DATA_DIR ?? './data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const configPath = path.resolve(process.env.PR_REMINDER_CONFIG ?? path.join(dataDir, 'config.json'));
  const host = process.env.PR_REMINDER_HOST ?? '127.0.0.1';
  const port = Number(process.env.PR_REMINDER_PORT ?? 47615);
  if (!isLoopback(host)) {
    logger.warn('Service API is listening on a non-loopback address. Put it behind TLS (reverse proxy or SSH tunnel).', { host });
  }

  const configStore = new ConfigStore(configPath);
  try {
    configStore.load();
  } catch (error) {
    logger.error('Configuration file is invalid; waiting for a valid config via the API', { error: safeErrorMessage(error) });
  }

  const store = new Store(path.join(dataDir, 'pr-reminder.db'));
  const service = new NotificationService({ store, configStore, secrets, logger, dataDir });
  const api = new ApiServer(service, secrets.apiToken, logger.child({ component: 'api' }));
  service.onStop(() => api.close());

  const address = await api.listen(port, host);
  service.start();
  logger.info('Service started', { host: address.address, port: address.port, configured: configStore.get() !== null });
  // Machine-readable readiness line consumed by the extension's service manager.
  process.stdout.write(`PR_REMINDER_READY ${address.port}\n`);

  const shutdown = (signal: string) => {
    logger.info('Shutting down', { signal });
    void service.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // When launched by the extension, exit if the parent goes away (stdin closes).
  if (process.env.PR_REMINDER_EXIT_WITH_PARENT === '1') {
    process.stdin.on('end', () => shutdown('parent-exit'));
    process.stdin.resume();
  }
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: safeErrorMessage(error) });
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (error) => {
    logger.error('Unhandled rejection', { error: safeErrorMessage(error) });
  });
}

void main();
