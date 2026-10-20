/**
 * Pure alert decision logic (no VS Code dependency, unit tested).
 *
 * Acknowledging an alert only marks the local notification as seen. It never
 * changes anything on GitHub and never marks a review as completed.
 */
import type { EventType } from '../../shared/events';
import type { EventDto } from '../../shared/protocol';

export type AlertStyle = 'notification' | 'banner' | 'sound' | 'statusBar';

export interface AlertSettings {
  highStyles: AlertStyle[];
  normalStyles: AlertStyle[];
  soundEnabled: boolean;
  quietMode: boolean;
  repeatTypes: EventType[];
  repeatIntervalMs: number;
}

export interface AlertDecision {
  event: EventDto;
  styles: AlertStyle[];
}

export class AlertState {
  private readonly open = new Map<number, { event: EventDto; lastShownAt: number }>();
  private snoozedUntil = 0;

  constructor(private settings: AlertSettings) {}

  updateSettings(settings: AlertSettings): void {
    this.settings = settings;
  }

  isSnoozed(now: number): boolean {
    return now < this.snoozedUntil;
  }

  snoozeUntil(): number | null {
    return this.snoozedUntil > 0 ? this.snoozedUntil : null;
  }

  snooze(durationMs: number, now: number): void {
    this.snoozedUntil = now + durationMs;
  }

  clearSnooze(): void {
    this.snoozedUntil = 0;
  }

  /** Styles to use for an event right now, after quiet mode, snooze and sound settings. */
  stylesFor(event: EventDto, now: number): AlertStyle[] {
    if (event.severity === 'off') {
      return [];
    }
    let styles = [...(event.severity === 'high' ? this.settings.highStyles : this.settings.normalStyles)];
    if (!this.settings.soundEnabled) {
      styles = styles.filter((s) => s !== 'sound');
    }
    if (this.settings.quietMode || this.isSnoozed(now)) {
      // Only the passive status bar counter remains during quiet mode / snooze.
      styles = styles.filter((s) => s === 'statusBar');
    }
    return styles;
  }

  /** Registers new events and returns how to present each one. Already-known or acknowledged events are ignored. */
  ingest(events: EventDto[], now: number): AlertDecision[] {
    const decisions: AlertDecision[] = [];
    for (const event of [...events].sort((a, b) => a.id - b.id)) {
      if (event.acknowledged || event.historical || this.open.has(event.id) || event.severity === 'off') {
        continue;
      }
      this.open.set(event.id, { event, lastShownAt: now });
      decisions.push({ event, styles: this.stylesFor(event, now) });
    }
    return decisions;
  }

  /** Events configured to repeat that are unacknowledged and due for another alert. */
  dueRepeats(now: number): AlertDecision[] {
    if (this.settings.quietMode || this.isSnoozed(now) || this.settings.repeatTypes.length === 0) {
      return [];
    }
    const due: AlertDecision[] = [];
    for (const entry of this.open.values()) {
      if (this.settings.repeatTypes.includes(entry.event.type) && now - entry.lastShownAt >= this.settings.repeatIntervalMs) {
        entry.lastShownAt = now;
        due.push({ event: entry.event, styles: this.stylesFor(entry.event, now).filter((s) => s !== 'statusBar') });
      }
    }
    return due;
  }

  acknowledge(ids: number[] | 'all'): number[] {
    const removed = ids === 'all' ? [...this.open.keys()] : ids.filter((id) => this.open.has(id));
    for (const id of removed) {
      this.open.delete(id);
    }
    return removed;
  }

  unacknowledged(): EventDto[] {
    return [...this.open.values()].map((e) => e.event).sort((a, b) => b.id - a.id);
  }

  unacknowledgedCount(): number {
    return this.open.size;
  }

  hasHighPriority(): boolean {
    return [...this.open.values()].some((e) => e.event.severity === 'high');
  }
}
