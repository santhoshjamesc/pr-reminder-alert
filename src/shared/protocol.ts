/**
 * Data transfer objects exchanged between the notification service HTTP API
 * and the VS Code extension. These types never contain secrets.
 *
 * All endpoints except GET /health require `Authorization: Bearer <token>`.
 * See README.md "Service API" for the full endpoint list.
 */
import type { EventType, Severity } from './events';

export type PrState = 'open' | 'merged' | 'closed' | 'inaccessible';
export type CiState = 'success' | 'failure' | 'pending' | 'none';
export type ReviewerStatus = 'pending' | 'responded' | 'removed';

export interface ReviewerDto {
  login: string;
  kind: 'user' | 'team';
  status: ReviewerStatus;
  reviewState: string | null;
  mapped: boolean;
  /** Masked Workspace email used for the Chat DM (e.g. r***@example.com), never the full address. */
  maskedEmail: string | null;
  /** Masked WhatsApp number (e.g. +91******3210), never the full number. */
  maskedPhone: string | null;
  reminderCount: number;
  lastNotifiedAt: string | null;
  nextReminderAt: string | null;
}

export interface PullRequestDto {
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: PrState;
  draft: boolean;
  author: string;
  createdAt: string;
  updatedAt: string;
  paused: boolean;
  ciState: CiState;
  headSha: string;
  reviewers: ReviewerDto[];
  lastNotifiedAt: string | null;
  nextReminderAt: string | null;
}

export interface EventDto {
  id: number;
  key: string;
  prKey: string;
  repo: string;
  number: number;
  prTitle: string;
  type: EventType;
  severity: Severity;
  summary: string;
  url: string;
  actor: string | null;
  occurredAt: string;
  recordedAt: string;
  historical: boolean;
  acknowledged: boolean;
}

export interface UnmappedReviewerDto {
  login: string;
  kind: 'user' | 'team';
  prKeys: string[];
}

export interface DeliveryFailureDto {
  id: number;
  kind: string;
  channel: 'chat' | 'whatsapp';
  prKey: string;
  recipient: string;
  attempts: number;
  lastError: string | null;
  status: string;
}

/** A reviewer message in the outbox, newest first. Recipients are masked. */
export interface MessageDto {
  id: number;
  kind: 'initial' | 'reminder';
  channel: 'chat' | 'whatsapp';
  prKey: string;
  reviewer: string;
  recipient: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  nextAttemptAt: string;
}

export interface ServiceStatusDto {
  version: string;
  /** Build timestamp of the running service; missing on services from before it was added. */
  build?: number;
  startedAt: string;
  githubConfigured: boolean;
  chatConfigured: boolean;
  whatsappEnabled: boolean;
  /** A WhatsApp account has been linked by scanning the QR code. */
  whatsappLinked: boolean;
  whatsappError: string | null;
  /** What WhatsApp Web is doing right now (e.g. "Sending to +91******3210…"), or null when idle. */
  whatsappActivity: string | null;
  githubUser: string | null;
  globalPaused: boolean;
  baselineComplete: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  nextSyncAt: string | null;
  rateLimit: { remaining: number | null; limit: number | null; resetAt: string | null };
  pendingMessages: number;
  failedMessages: number;
  unacknowledgedAlerts: number;
}

export interface TestChatResultDto {
  ok: boolean;
  message: string;
}
