/**
 * The control DO's single alarm. It composes `alarmAt` from the canonical
 * allocation deadline (`sandbox-state/schedule.ts`) plus the infrastructure
 * anchors the allocation machine does not own (the socket-handshake and
 * credential deadlines), and it is the only module that calls `setAlarm` /
 * `deleteAlarm`.
 *
 * The infrastructure anchors are owned here, under their own storage key, so the
 * live path never reads or writes the legacy deadline table (`deadlines.ts`),
 * which only the dead pre-cutover modules still use.
 */
import { z } from 'zod';
import type { AllocationRecord } from '../sandbox-state/model/allocation.js';
import { allocationAlarmAt } from '../sandbox-state/schedule.js';

export const CONTROL_ALARM_ANCHORS_KEY = 'control_alarm_anchors';

export type AlarmScheduler = {
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

/** The two infrastructure anchors the canonical allocation machine does not own. */
export type ControlAlarmAnchorId = 'credentialExpiry' | 'socketHandshake';

export type ControlAlarmAnchorState = {
  credentialExpiryAt: number | null;
  socketHandshakeAt: number | null;
};

export type ControlAlarmAnchors = {
  /** Canonical allocation aggregate, or `null` before first load. */
  allocation: AllocationRecord | null;
  credentialExpiryAt: number | null;
  socketHandshakeAt: number | null;
};

type AnchorStorage = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
};

const controlAlarmAnchorStateSchema = z.object({
  credentialExpiryAt: z.number().int().nonnegative().nullable(),
  socketHandshakeAt: z.number().int().nonnegative().nullable(),
});

export function emptyControlAlarmAnchors(): ControlAlarmAnchorState {
  return { credentialExpiryAt: null, socketHandshakeAt: null };
}

export function controlAlarmAnchorAt(
  anchors: ControlAlarmAnchorState,
  id: ControlAlarmAnchorId
): number | null {
  return id === 'credentialExpiry' ? anchors.credentialExpiryAt : anchors.socketHandshakeAt;
}

export async function loadControlAlarmAnchors(
  storage: AnchorStorage
): Promise<ControlAlarmAnchorState> {
  const parsed = controlAlarmAnchorStateSchema.safeParse(
    await storage.get(CONTROL_ALARM_ANCHORS_KEY)
  );
  return parsed.success ? parsed.data : emptyControlAlarmAnchors();
}

export async function setControlAlarmAnchor(
  storage: AnchorStorage,
  id: ControlAlarmAnchorId,
  at: number | null
): Promise<ControlAlarmAnchorState> {
  const current = await loadControlAlarmAnchors(storage);
  const next: ControlAlarmAnchorState =
    id === 'credentialExpiry'
      ? { ...current, credentialExpiryAt: at }
      : { ...current, socketHandshakeAt: at };
  await storage.put(CONTROL_ALARM_ANCHORS_KEY, next);
  return next;
}

/** Infrastructure anchors that are due at `now`, earliest first. */
export function dueControlAlarmAnchors(
  anchors: ControlAlarmAnchorState,
  now: number
): ControlAlarmAnchorId[] {
  const due: Array<{ id: ControlAlarmAnchorId; at: number }> = [];
  if (anchors.credentialExpiryAt !== null && anchors.credentialExpiryAt <= now) {
    due.push({ id: 'credentialExpiry', at: anchors.credentialExpiryAt });
  }
  if (anchors.socketHandshakeAt !== null && anchors.socketHandshakeAt <= now) {
    due.push({ id: 'socketHandshake', at: anchors.socketHandshakeAt });
  }
  return due.sort((a, b) => a.at - b.at).map(entry => entry.id);
}

/** Earliest eligible anchor; `null` means no alarm should be armed. */
export function composeControlAlarmAt(anchors: ControlAlarmAnchors): number | null {
  const candidates: number[] = [];
  if (anchors.allocation !== null) {
    const allocationDeadline = allocationAlarmAt(anchors.allocation);
    if (allocationDeadline !== null) candidates.push(allocationDeadline);
  }
  if (anchors.credentialExpiryAt !== null) candidates.push(anchors.credentialExpiryAt);
  if (anchors.socketHandshakeAt !== null) candidates.push(anchors.socketHandshakeAt);
  return candidates.length === 0 ? null : Math.min(...candidates);
}

/** Apply the composed alarm through the scheduler; returns the armed time. */
export async function scheduleControlAlarm(
  scheduler: AlarmScheduler,
  anchors: ControlAlarmAnchors
): Promise<number | null> {
  const at = composeControlAlarmAt(anchors);
  if (at === null) {
    await scheduler.deleteAlarm();
    return null;
  }
  await scheduler.setAlarm(at);
  return at;
}
