import { afterEach, describe, expect, it } from 'vitest';
import { ApiServer } from '../src/service/api/server';
import { RateLimiter } from '../src/service/api/rateLimiter';
import { ConfigStore } from '../src/service/config/configStore';
import { silentLogger } from '../src/service/logging/logger';
import { NotificationService } from '../src/service/service';
import { Store } from '../src/service/storage/store';
import { FakeGitHub, MockChatTransport, makeConfig, makeSnapshot } from './helpers/fixtures';

const TOKEN = 'a'.repeat(64);
let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup) {
    await fn();
  }
  cleanup = [];
});

async function startApi() {
  const github = new FakeGitHub();
  github.put(makeSnapshot());
  const transport = new MockChatTransport();
  const configStore = new ConfigStore(null);
  configStore.update(makeConfig());
  const service = new NotificationService({
    store: new Store(':memory:'),
    configStore,
    secrets: { apiToken: TOKEN, githubToken: 'ghp_test', googleClientId: 'id.apps.googleusercontent.com', googleClientSecret: 'GOCSPX-testsecret123', googleRefreshToken: '1//refresh-token-test-value-123' },
    logger: silentLogger,
    gatewayFactory: () => github,
    chatTransportFactory: () => transport,
  });
  const api = new ApiServer(service, TOKEN, silentLogger);
  const address = await api.listen(0, '127.0.0.1');
  cleanup.push(() => service.stop(), () => api.close());
  const base = `http://127.0.0.1:${address.port}`;
  const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  return { call, service, transport, base };
}

describe('service API', () => {
  it('requires a valid bearer token on every endpoint except /health', async () => {
    const { call } = await startApi();
    expect((await call('/health', {}, null)).status).toBe(200);
    expect((await call('/api/status', {}, null)).status).toBe(401);
    expect((await call('/api/status', {}, 'b'.repeat(64))).status).toBe(401);
    const ok = await call('/api/status');
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { githubConfigured: boolean };
    expect(body.githubConfigured).toBe(true);
    expect(JSON.stringify(body)).not.toContain('ghp_test');
    expect(JSON.stringify(body)).not.toContain('GOCSPX');
    expect(JSON.stringify(body)).not.toContain('refresh-token-test');
  });

  it('rejects browser cross-origin requests', async () => {
    const { call } = await startApi();
    expect((await call('/api/status', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('syncs, lists PRs with masked emails, acknowledges alerts and validates input', async () => {
    const { call } = await startApi();
    const sync = (await (await call('/api/sync', { method: 'POST' })).json()) as { prsSynced: number };
    expect(sync.prsSynced).toBe(1);
    const prs = (await (await call('/api/prs')).json()) as Array<{ key: string; reviewers: Array<{ maskedEmail: string }> }>;
    expect(prs[0]!.key).toBe('acme/widgets#1');
    expect(prs[0]!.reviewers[0]!.maskedEmail).toBe('r***@example.com');
    expect(JSON.stringify(prs)).not.toContain('reviewer1@example.com');

    expect((await call('/api/pause', { method: 'POST', body: JSON.stringify({ prKey: 'acme/widgets#1' }) })).status).toBe(200);
    expect((await call('/api/pause', { method: 'POST', body: JSON.stringify({ prKey: 'not valid' }) })).status).toBe(400);
    expect((await call('/api/alerts/ack', { method: 'POST', body: JSON.stringify({ all: true }) })).status).toBe(200);
    expect((await call('/api/alerts/ack', { method: 'POST', body: '{bad json' })).status).toBe(400);
    expect((await call('/api/config', { method: 'PUT', body: JSON.stringify({ github: { username: '' } }) })).status).toBe(400);
    expect((await call('/api/nope')).status).toBe(404);
  });

  it('tests the Google Chat connection, optionally sending a test DM to a mapped reviewer', async () => {
    const { call, transport } = await startApi();
    expect(await (await call('/api/test-chat', { method: 'POST' })).json()).toMatchObject({ ok: true });
    expect(transport.sent).toHaveLength(0);
    const sent = await (await call('/api/test-chat', { method: 'POST', body: JSON.stringify({ reviewer: 'reviewer-one' }) })).json();
    expect(sent).toMatchObject({ ok: true, message: 'Test DM sent to r***@example.com.' });
    expect(transport.sent[0]!.to).toBe('reviewer1@example.com');
    expect(await (await call('/api/test-chat', { method: 'POST', body: JSON.stringify({ reviewer: 'nobody' }) })).json()).toMatchObject({ ok: false });
  });

  it('rate limits clients', () => {
    let t = 0;
    const limiter = new RateLimiter(3, 1, () => t);
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([true, true, true, false]);
    expect(limiter.take('b')).toBe(true);
    t = 1000;
    expect(limiter.take('a')).toBe(true);
  });
});
