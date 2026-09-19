/**
 * The control DO's single alarm. It composes `alarmAt` from the canonical
 * allocation deadline (`sandbox-state/schedule.ts`) plus the infrastructure
 * anchors the allocation machine does not own (the socket-handshake and
 * credential deadlines), and it is the only module that calls `setAlarm` /
 * `deleteAlarm`.
 */
import type { AllocationRecord } from '../sandbox-state/model/allocation.js';
import { allocationAlarmAt } from '../sandbox-state/schedule.js';

export type AlarmScheduler = {
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

export type ControlAlarmAnchors = {
  /** Canonical allocation aggregate, or `null` before first load. */
  allocation: AllocationRecord | null;
  credentialExpiryAt: number | null;
  socketHandshakeAt: number | null;
};

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
