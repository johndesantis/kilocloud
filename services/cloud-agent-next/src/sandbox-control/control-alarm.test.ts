import { describe, expect, it } from 'vitest';
import type { AllocationRecord, AllocationTarget } from '../sandbox-state/model/allocation.js';
import { POLICY } from '../sandbox-state/schedule.js';
import {
  composeControlAlarmAt,
  scheduleControlAlarm,
  type AlarmScheduler,
} from './control-alarm.js';

const NOW = 1_000_000;
const CAPS: AllocationTarget['capabilities'] = {
  persistentWorkspace: false,
  destroysOnStop: true,
};
const TARGET: AllocationTarget = {
  provider: 'cloudflare',
  providerRef: 'ref-1',
  capabilities: CAPS,
};

function allocated(deadlineAt = NOW + POLICY.heartbeatExpiryMs): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'allocated',
      target: TARGET,
      createIntent: { intentId: 'intent-1', createdAt: NOW - 1_000 },
      health: {
        kind: 'healthy',
        incarnation: 'inc-1',
        lastHeartbeat: { incarnation: 'inc-1', at: NOW, ready: true },
        deadlineAt,
      },
      idleAt: null,
    },
  };
}

function stopped(): AllocationRecord {
  return { v: 2, resumable: true, state: { kind: 'stopped', summary: null } };
}

function recordingScheduler(): AlarmScheduler & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    setAlarm: async at => {
      calls.push(`set:${at}`);
    },
    deleteAlarm: async () => {
      calls.push('delete');
    },
  };
}

describe('control alarm composition', () => {
  it('takes the earliest of the allocation, credential and socket anchors', () => {
    expect(
      composeControlAlarmAt({
        allocation: allocated(NOW + 500),
        credentialExpiryAt: NOW + 5_000,
        socketHandshakeAt: NOW + 3_000,
      })
    ).toBe(NOW + 500);
    expect(
      composeControlAlarmAt({
        allocation: allocated(),
        credentialExpiryAt: NOW + 1_000,
        socketHandshakeAt: NOW + 3_000,
      })
    ).toBe(NOW + 1_000);
    expect(
      composeControlAlarmAt({
        allocation: allocated(),
        credentialExpiryAt: NOW + 5_000,
        socketHandshakeAt: NOW + 200,
      })
    ).toBe(NOW + 200);
  });

  it('ignores a stopped allocation and uses only the infrastructure anchors', () => {
    expect(
      composeControlAlarmAt({
        allocation: stopped(),
        credentialExpiryAt: NOW + 5_000,
        socketHandshakeAt: null,
      })
    ).toBe(NOW + 5_000);
  });

  it('returns null when no anchor is armed', () => {
    expect(
      composeControlAlarmAt({
        allocation: stopped(),
        credentialExpiryAt: null,
        socketHandshakeAt: null,
      })
    ).toBeNull();
  });
});

describe('control alarm scheduling', () => {
  it('sets the composed alarm through the scheduler', async () => {
    const scheduler = recordingScheduler();
    const at = await scheduleControlAlarm(scheduler, {
      allocation: allocated(NOW + 500),
      credentialExpiryAt: NOW + 5_000,
      socketHandshakeAt: null,
    });
    expect(at).toBe(NOW + 500);
    expect(scheduler.calls).toEqual([`set:${NOW + 500}`]);
  });

  it('deletes the alarm when nothing is armed', async () => {
    const scheduler = recordingScheduler();
    expect(
      await scheduleControlAlarm(scheduler, {
        allocation: null,
        credentialExpiryAt: null,
        socketHandshakeAt: null,
      })
    ).toBeNull();
    expect(scheduler.calls).toEqual(['delete']);
  });
});
