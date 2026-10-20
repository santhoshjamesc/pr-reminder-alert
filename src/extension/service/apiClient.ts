import type {
  DeliveryFailureDto,
  EventDto,
  MessageDto,
  PullRequestDto,
  ServiceStatusDto,
  TestChatResultDto,
  UnmappedReviewerDto,
} from '../../shared/protocol';
import { redactString } from '../../shared/redact';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Typed client for the notification service API (bearer-token authenticated). */
export class ApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 20_000,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      const data = text ? (JSON.parse(text) as unknown) : null;
      if (!res.ok) {
        const message = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
        throw new ApiError(redactString(message), res.status);
      }
      return data as T;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(redactString(error instanceof Error ? error.message : String(error)), 0);
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  status = () => this.request<ServiceStatusDto>('GET', '/api/status');
  pullRequests = () => this.request<PullRequestDto[]>('GET', '/api/prs');
  events = (since: number, limit = 200, historical = false) =>
    this.request<EventDto[]>('GET', `/api/events?since=${since}&limit=${limit}&historical=${historical ? 1 : 0}`);
  unmapped = () => this.request<UnmappedReviewerDto[]>('GET', '/api/unmapped');
  failedMessages = () => this.request<DeliveryFailureDto[]>('GET', '/api/messages/failed');
  messages = (limit = 50) => this.request<MessageDto[]>('GET', `/api/messages?limit=${limit}`);
  sync = () => this.request<{ prsSynced: number; newEvents: number; errors: string[] }>('POST', '/api/sync', {}, 120_000);
  pause = (prKey?: string) => this.request<{ ok: boolean }>('POST', '/api/pause', prKey ? { prKey } : {});
  resume = (prKey?: string) => this.request<{ ok: boolean }>('POST', '/api/resume', prKey ? { prKey } : {});
  acknowledge = (ids: number[] | 'all') => this.request<{ acknowledged: number }>('POST', '/api/alerts/ack', ids === 'all' ? { all: true } : { ids });
  retryMessages = (ids?: number[]) => this.request<{ requeued: number }>('POST', '/api/messages/retry', ids ? { ids } : { all: true });
  clearMessages = (ids?: number[]) => this.request<{ cleared: number }>('POST', '/api/messages/clear', ids ? { ids } : { all: true });
  testChat = (reviewer?: string) => this.request<TestChatResultDto>('POST', '/api/test-chat', reviewer ? { reviewer } : {}, 60_000);
  testWhatsApp = (reviewer?: string) => this.request<TestChatResultDto>('POST', '/api/test-whatsapp', reviewer ? { reviewer } : {}, 120_000);
  /** Waits while the user scans the QR code (up to 3 minutes). */
  linkWhatsApp = () => this.request<TestChatResultDto>('POST', '/api/whatsapp/link', {}, 240_000);
  unlinkWhatsApp = () => this.request<{ ok: true }>('POST', '/api/whatsapp/unlink', {});
  putConfig = (config: unknown) => this.request<{ ok: true }>('PUT', '/api/config', config);
  shutdown = () => this.request<{ ok: true }>('POST', '/api/shutdown', {}, 3000);
}
