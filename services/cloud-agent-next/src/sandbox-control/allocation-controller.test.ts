import { describe, expect, it } from 'vitest';
import { decideAllocation } from '../sandbox-state/allocation/reduce.js';
import type { AllocationRecord, AllocationTarget } from '../sandbox-state/model/allocation.js';
import { allocationRecordSchema } from '../sandbox-state/model/allocation.js';
import { POLICY } from '../sandbox-state/schedule.js';
import { ALLOCATION_KEY, type CanonicalStorage } from '../sandbox-state/persist/store.js';
import {
  AllocationLoadError,
  ACQUISITION_RECEIPTS_KEY,
  createAllocationController,
} from './allocation-controller.js';

const NOW = 1_000_000;
const INC = 'inc-1';

const CAPS: AllocationTarget['capabilities'] = {
  persistentWorkspace: false,
  destroysOnStop: true,
};
const TARGET: AllocationTarget = {
  provider: 'cloudflare',
  providerRef: 'ref-1',
  capabilities: CAPS,
};
const CREATE_INTENT = { intentId: 'intent-1', createdAt: NOW - 5_000 };

function seededStorage(
  data: Map<string, unknown>
): CanonicalStorage & { data: Map<string, unknown> } {
  return {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      data.set(key, value);
    },
  };
}

function allocatedRecord(): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'allocated',
      target: TARGET,
      createIntent: CREATE_INTENT,
      health: {
        kind: 'healthy',
        incarnation: INC,
        lastHeartbeat: { incarnation: INC, at: NOW - 1_000, ready: true },
        deadlineAt: NOW + POLICY.heartbeatExpiryMs,
      },
      idleAt: null,
    },
  };
}

function allocatedRecordWithIntent(intentId: string): AllocationRecord {
  const record = allocatedRecord();
  if (record.state.kind !== 'allocated') throw new Error('expected allocated');
  return {
    ...record,
    state: { ...record.state, createIntent: { intentId, createdAt: NOW - 1 } },
  };
}

function controllerFor(record: AllocationRecord | null, now = NOW) {
  const data = new Map<string, unknown>();
  if (record) data.set(ALLOCATION_KEY, record);
  const storage = seededStorage(data);
  return {
    data,
    storage,
    controller: createAllocationController({ storage, now: () => now }),
  };
}

describe('allocation controller — single writer / dispatcher', () => {
  it('loads the initial canonical record from empty storage', async () => {
    const { controller } = controllerFor(null);
    const record = await controller.load();
    expect(record.state.kind).toBe('stopped');
  });

  it('dispatches through decideAllocation, persists, and returns the commands', async () => {
    const { controller, data } = controllerFor(null);
    const decision = await controller.dispatch(
      { type: 'DEMAND', requestId: 'req-1', target: TARGET, createIntent: CREATE_INTENT },
      NOW
    );
    expect(decision?.state.state.kind).toBe('creating');
    expect(decision?.commands.map(command => command.kind)).toEqual(['Create']);
    expect(allocationRecordSchema.parse(data.get(ALLOCATION_KEY))).toEqual(decision?.state);
  });

  it('returns undefined and persists nothing for a rejected event', async () => {
    const creating: AllocationRecord = {
      v: 2,
      resumable: true,
      state: {
        kind: 'creating',
        requestId: 'req-1',
        target: TARGET,
        createIntent: CREATE_INTENT,
        attempt: 1,
        deadlineAt: NOW + POLICY.createDeadlineMs,
      },
    };
    const { controller, data } = controllerFor(creating);
    const before = data.get(ALLOCATION_KEY);
    const decision = await controller.dispatch({ type: 'IDLE', idleAt: NOW }, NOW);
    expect(decision).toBeUndefined();
    expect(data.get(ALLOCATION_KEY)).toBe(before);
  });

  it('yields the same decision for a health event as a direct decideAllocation call', async () => {
    const { controller } = controllerFor(allocatedRecord());
    const event = { type: 'HEARTBEAT', incarnation: INC, at: NOW, ready: false } as const;
    const throughController = await controller.dispatch(event, NOW);
    const direct = decideAllocation(allocatedRecord(), event, NOW);
    expect(throughController?.state).toEqual(direct?.state);
    expect(throughController?.commands).toEqual(direct?.commands);
    expect(throughController?.deadlineAt).toBe(direct?.deadlineAt);
    expect(throughController?.state.state.kind === 'allocated').toBe(true);
  });

  it('fails closed on a malformed canonical value', async () => {
    const { storage } = controllerFor(null);
    await storage.put(ALLOCATION_KEY, { v: 2, resumable: true, state: { kind: 'bogus' } });
    const failing = createAllocationController({ storage, now: () => NOW });
    await expect(failing.load()).rejects.toBeInstanceOf(AllocationLoadError);
    await expect(failing.dispatch({ type: 'CHECK' }, NOW)).rejects.toBeInstanceOf(
      AllocationLoadError
    );
  });
});

describe('allocation controller — acquisition fencing', () => {
  it('binds a live allocation and records one receipt', async () => {
    const { controller, storage } = controllerFor(allocatedRecord());
    const record = await controller.load();
    const bound = await controller.bindAcquisition(
      record,
      { id: 'acq-1', deadlineAt: NOW + 10_000 },
      NOW
    );
    expect(bound).toBe(true);
    const receipts = (await storage.get(ACQUISITION_RECEIPTS_KEY)) as Array<unknown>;
    expect(receipts).toHaveLength(1);
  });

  it('keeps a replayed request bound to the same allocation without a second receipt', async () => {
    const { controller, storage } = controllerFor(allocatedRecord());
    const record = await controller.load();
    const acquisition = { id: 'acq-1', deadlineAt: NOW + 10_000 };
    expect(await controller.bindAcquisition(record, acquisition, NOW)).toBe(true);
    expect(await controller.bindAcquisition(record, acquisition, NOW + 1)).toBe(true);
    const receipts = (await storage.get(ACQUISITION_RECEIPTS_KEY)) as Array<unknown>;
    expect(receipts).toHaveLength(1);
  });

  it('throws when the same request id changes deadline', async () => {
    const { controller } = controllerFor(allocatedRecord());
    const record = await controller.load();
    await controller.bindAcquisition(record, { id: 'acq-1', deadlineAt: NOW + 10_000 }, NOW);
    await expect(
      controller.bindAcquisition(record, { id: 'acq-1', deadlineAt: NOW + 20_000 }, NOW)
    ).rejects.toThrow('Sandbox acquisition deadline changed');
  });

  it('throws SandboxAcquisitionLostError when the bound allocation changed', async () => {
    const { controller } = controllerFor(allocatedRecord());
    const record = await controller.load();
    await controller.bindAcquisition(record, { id: 'acq-1', deadlineAt: NOW + 10_000 }, NOW);
    const other = allocatedRecordWithIntent('intent-2');
    await expect(
      controller.bindAcquisition(other, { id: 'acq-1', deadlineAt: NOW + 10_000 }, NOW)
    ).rejects.toMatchObject({ name: 'SandboxAcquisitionLostError' });
  });

  it('rejects an expired acquisition', async () => {
    const { controller } = controllerFor(allocatedRecord());
    const record = await controller.load();
    await expect(
      controller.bindAcquisition(record, { id: 'acq-1', deadlineAt: NOW }, NOW)
    ).rejects.toThrow('Sandbox acquisition expired');
  });

  it('does not bind a stopped allocation', async () => {
    const { controller } = controllerFor(null);
    const record = await controller.load();
    expect(
      await controller.bindAcquisition(record, { id: 'acq-1', deadlineAt: NOW + 10_000 }, NOW)
    ).toBe(false);
  });
});
