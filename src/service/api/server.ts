import * as http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { z, ZodError } from 'zod';
import { safeErrorMessage } from '../../shared/redact';
import { ConfigError, formatZodError } from '../config/configStore';
import type { Logger } from '../logging/logger';
import type { NotificationService } from '../service';
import { RateLimiter } from './rateLimiter';

const MAX_BODY_BYTES = 256 * 1024;

const prKeyBody = z.object({ prKey: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/).optional() }).strict();
const ackBody = z.union([z.object({ all: z.literal(true) }).strict(), z.object({ ids: z.array(z.number().int().positive()).max(1000) }).strict()]);
const testChatBody = z.object({ reviewer: z.string().max(100).optional() }).strict();
const retryBody = z.union([z.object({ all: z.literal(true) }).strict(), z.object({ ids: z.array(z.number().int().positive()).max(1000) }).strict()]);
const eventsQuery = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  historical: z.enum(['0', '1']).default('0'),
});

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Request body too large');
    }
    chunks.push(chunk as Buffer);
  }
  if (size === 0) {
    return {};
  }
  if (!(req.headers['content-type'] ?? '').includes('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/**
 * Authenticated JSON API used by the VS Code extension.
 * - Every route except GET /health requires `Authorization: Bearer <token>`.
 * - Requests are rate limited per client address.
 * - Responses never contain secrets; errors are redacted.
 */
export class ApiServer {
  private server: http.Server | null = null;
  private readonly limiter = new RateLimiter(120, 2);
  private readonly authFailures = new RateLimiter(10, 0.1);

  constructor(
    private readonly service: NotificationService,
    private readonly token: string,
    private readonly logger: Logger,
  ) {}

  listen(port: number, host: string): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      server.requestTimeout = 30_000;
      server.headersTimeout = 10_000;
      server.once('error', reject);
      server.listen(port, host, () => {
        this.server = server;
        resolve(server.address() as AddressInfo);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server.closeAllConnections();
      this.server = null;
    });
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const client = req.socket.remoteAddress ?? 'unknown';
    try {
      // Browsers attach Origin; the extension (Node fetch) does not. Reject cross-site browser requests outright.
      if (req.headers.origin) {
        throw new HttpError(403, 'Cross-origin requests are not allowed');
      }
      if (!this.limiter.take(client)) {
        throw new HttpError(429, 'Too many requests');
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /health') {
        this.send(res, 200, { ok: true });
        return;
      }
      const header = req.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!presented || !tokensEqual(presented, this.token)) {
        if (!this.authFailures.take(client)) {
          throw new HttpError(429, 'Too many failed authentication attempts');
        }
        throw new HttpError(401, 'Unauthorized');
      }
      this.send(res, 200, await this.route(route, url, req));
    } catch (error) {
      if (error instanceof HttpError) {
        this.send(res, error.status, { error: error.message });
      } else if (error instanceof ZodError) {
        this.send(res, 400, { error: formatZodError(error) });
      } else if (error instanceof ConfigError) {
        this.send(res, 400, { error: safeErrorMessage(error) });
      } else {
        this.logger.error('API request failed', { error: safeErrorMessage(error) });
        this.send(res, 500, { error: safeErrorMessage(error) });
      }
    }
  }

  private async route(route: string, url: URL, req: http.IncomingMessage): Promise<unknown> {
    const s = this.service;
    switch (route) {
      case 'GET /api/status':
        return s.status();
      case 'GET /api/prs':
        return s.listPullRequests();
      case 'GET /api/events': {
        const q = eventsQuery.parse(Object.fromEntries(url.searchParams));
        return s.listEvents(q.since, q.limit, q.historical === '1');
      }
      case 'GET /api/unmapped':
        return s.listUnmapped();
      case 'GET /api/messages/failed':
        return s.listFailedMessages();
      case 'GET /api/messages':
        return s.listMessages(Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50)));
      case 'POST /api/sync':
        return s.syncNow();
      case 'POST /api/pause': {
        const body = prKeyBody.parse(await readJson(req));
        return s.setPaused(true, body.prKey);
      }
      case 'POST /api/resume': {
        const body = prKeyBody.parse(await readJson(req));
        return s.setPaused(false, body.prKey);
      }
      case 'POST /api/alerts/ack': {
        const body = ackBody.parse(await readJson(req));
        return s.acknowledge('all' in body ? 'all' : body.ids);
      }
      case 'POST /api/messages/retry': {
        const body = retryBody.parse(await readJson(req));
        return s.retryFailedMessages('all' in body ? 'all' : body.ids);
      }
      case 'POST /api/messages/clear': {
        const body = retryBody.parse(await readJson(req));
        return s.clearFailedMessages('all' in body ? 'all' : body.ids);
      }
      case 'POST /api/test-chat': {
        const body = testChatBody.parse(await readJson(req));
        return s.testChat(body.reviewer);
      }
      case 'POST /api/test-whatsapp': {
        const body = testChatBody.parse(await readJson(req));
        return s.testWhatsApp(body.reviewer);
      }
      case 'POST /api/whatsapp/link':
        return s.linkWhatsApp();
      case 'POST /api/whatsapp/unlink':
        return s.unlinkWhatsApp();
      case 'PUT /api/config':
        return s.updateConfig(await readJson(req));
      case 'POST /api/shutdown':
        setImmediate(() => void s.stop());
        return { ok: true };
      default:
        throw new HttpError(404, 'Not found');
    }
  }
}
