import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedAllocationRecord } from '../sandbox-state/persist/access.js';
import { loadAllocation } from '../sandbox-state/persist/load.js';
import type { CanonicalStorage } from '../sandbox-state/persist/store.js';
import type { AllocationRecord, AllocationTarget } from '../sandbox-state/model/allocation.js';
import {
  beginStop,
  claimCreate,
  confirmRunning,
  confirmStopped,
  fail,
  initialPhysicalRecord,
  observe,
  recordStopAttempt,
  type PhysicalRecord,
} from './physical-lifecycle.js';
import { projectAllocationToFlat } from './allocation-view.js';

const NOW = 1_000_000;
const CONTAINMENT = { kilocode: true, github: true, worktreeScoped: true } as const;

function storageFrom(records: Map<string, unknown>): CanonicalStorage {
  return {
    get: async <T>(key: string) => records.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      records.set(key, value);
    },
  };
}

/** Load the flat fixture through the real legacy decoder, then project back. */
async function roundTrip(flat: PhysicalRecord): Promise<PhysicalRecord> {
  const records = seedAllocationRecord(new Map<string, unknown>(), flat);
  const loaded = await loadAllocation(storageFrom(records), flat.resumable);
  expect(loaded.ok, loaded.ok ? '' : loaded.reason).toBe(true);
  if (!loaded.ok) throw new Error(loaded.reason);
  return projectAllocationToFlat(loaded.value) as PhysicalRecord;
}

const CF_TARGET: AllocationTarget = {
  provider: 'cloudflare',
  providerRef: null,
  capabilities: { persistentWorkspace: false, destroysOnStop: true },
};

describe('allocation view — canonical to flat projection', () => {
  it('projects the stopped terminal shape with null allocation fields', async () => {
    const records = new Map<string, unknown>();
    await storageFrom(records).put('sandbox_allocation_state', {
      v: 2,
      resumable: true,
      state: { kind: 'stopped', summary: { providerRef: 'ref-1', allocationName: 'name' } },
    } satisfies AllocationRecord);
    const loaded = await loadAllocation(storageFrom(records), true);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(projectAllocationToFlat(loaded.value)).toEqual({
      state: 'stopped',
      providerRef: null,
      createIntent: null,
      stopTombstone: null,
      resumable: true,
    });
  });

  it('projects a vercel creating target into the flat create intent', () => {
    const record: AllocationRecord = {
      v: 2,
      resumable: false,
      state: {
        kind: 'creating',
        requestId: 'req-1',
        target: {
          provider: 'vercel',
          providerRef: null,
          allocationName: 'vercel-small',
          vercel: { snapshotId: 'snap-1' },
          capabilities: { persistentWorkspace: true, destroysOnStop: false },
          containment: CONTAINMENT,
        },
        createIntent: { intentId: 'intent-1', createdAt: NOW - 1 },
        attempt: 1,
        deadlineAt: NOW + 1_000,
      },
    };
    expect(projectAllocationToFlat(record)).toEqual({
      state: 'creating',
      providerRef: null,
      createIntent: {
        intentId: 'intent-1',
        createdAt: NOW - 1,
        allocationName: 'vercel-small',
        vercel: { snapshotId: 'snap-1' },
        containment: CONTAINMENT,
      },
      stopTombstone: null,
      resumable: false,
    });
  });

  it('projects an unknown record with a stop tombstone', () => {
    const record: AllocationRecord = {
      v: 2,
      resumable: true,
      state: {
        kind: 'unknown',
        target: { ...CF_TARGET, providerRef: 'ref-1' },
        createIntent: { intentId: 'intent-1', createdAt: NOW - 5 },
        stopIntent: {
          reason: 'idle',
          createdAt: NOW - 4,
          incarnation: 'inc-1',
          wrapperInstanceId: 'w-1',
        },
        attempts: 2,
        reason: 'lost',
        deadlineAt: NOW + 1_000,
      },
    };
    expect(projectAllocationToFlat(record)).toEqual({
      state: 'unknown',
      providerRef: 'ref-1',
      createIntent: { intentId: 'intent-1', createdAt: NOW - 5 },
      stopTombstone: { reason: 'idle', attempts: 2, createdAt: NOW - 4, wrapperInstanceId: 'w-1' },
      resumable: true,
    });
  });
});

describe('allocation view — round trips the flat lifecycle', () => {
  it('reproduces each flat lifecycle record', async () => {
    const initial = initialPhysicalRecord(true);
    expect(await roundTrip(initial)).toEqual(initial);

    const created = claimCreate(initial, 'intent-1', NOW, 'alloc-name', CONTAINMENT);
    expect(await roundTrip(created)).toEqual(created);

    const running = confirmRunning(created, 'ref-1', NOW);
    expect(await roundTrip(running)).toEqual(running);

    const stopping = beginStop(running, 'idle', NOW, 'wrapper-1');
    expect(await roundTrip(stopping)).toEqual(stopping);

    const attempted = recordStopAttempt(stopping);
    expect(await roundTrip(attempted)).toEqual(attempted);

    const stopped = confirmStopped(attempted);
    expect(await roundTrip(stopped)).toEqual(stopped);

    const lost = observe(running, 'unknown');
    expect(await roundTrip(lost)).toEqual(lost);

    const failed = fail(running, NOW);
    expect(await roundTrip(failed)).toEqual(failed);
  });

  it('reproduces the failed legacy fixture from persist/load.test.ts', async () => {
    // Copied verbatim from `sandbox-state/persist/load.test.ts` (`legacyFailed`).
    const legacyFailed = {
      state: 'failed',
      providerRef: 'provider-ref-1',
      createIntent: { intentId: 'intent-1', createdAt: NOW - 5_000 },
      stopTombstone: {
        reason: 'environment_failed',
        attempts: 4,
        createdAt: NOW - 2_000,
      },
      resumable: true,
    } satisfies PhysicalRecord;
    expect(await roundTrip(legacyFailed)).toEqual(legacyFailed);
  });

  it('defines its own result type and never imports the flat module or persistence', () => {
    const source = readFileSync(join(__dirname, 'allocation-view.ts'), 'utf-8');
    expect(source).not.toMatch(/from\s+['"][^'"]*physical-lifecycle/);
    expect(source).not.toMatch(/from\s+['"][^'"]*sandbox-state\/persist/);
    expect(source).not.toContain('storeAllocation(');
  });
});
