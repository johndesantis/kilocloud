/**
 * Allocation aggregate controller. The single writer and single dispatcher for
 * the allocation machine: every event — including health events — is handed to
 * `decideAllocation`, which delegates health internally (`delegatedHealth` /
 * `applyHealth`) and applies the allocation-level consequence once. The
 * controller loads the canonical record, persists the decided record through
 * `storeAllocation`, and returns the commands for the effect runner. It performs
 * no provider I/O and makes no transition decision of its own.
 *
 * It also owns the acquisition/incarnation fencing (`bindAcquisition`
 * semantics). A request id binds to exactly one allocation identity; a changed
 * deadline throws an ordinary `Error` (matching the live
 * `SandboxControl.bindAcquisition`) and a mismatched live allocation throws
 * `SandboxAcquisitionLostError`, so a replayed request never starts a second
 * create.
 */
import { z } from 'zod';
import type { Command } from '../sandbox-state/commands.js';
import type { AllocationInputEvent } from '../sandbox-state/events.js';
import type { AllocationRecord } from '../sandbox-state/model/allocation.js';
import { decideAllocation } from '../sandbox-state/allocation/reduce.js';
import { loadAllocation } from '../sandbox-state/persist/load.js';
import { storeAllocation, type CanonicalStorage } from '../sandbox-state/persist/store.js';
import { SandboxAcquisitionLostError } from '../shared/sandbox-control-protocol.js';

/** Receipt key used by the live DO today; kept identical for the cutover. */
export const ACQUISITION_RECEIPTS_KEY = 'acquisition_receipts';

export type AllocationIdentity = { kind: 'intent' | 'provider'; id: string };

/** A session's acquisition demand: one request id, one delivery deadline. */
export type AllocationAcquisition = { id: string; deadlineAt: number };

export type AcquisitionReceipt = AllocationAcquisition & { allocation: AllocationIdentity };

const acquisitionReceiptsSchema = z.array(
  z.object({
    id: z.string().min(1).max(128),
    deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    allocation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('intent'), id: z.string().min(1) }),
      z.object({ kind: z.literal('provider'), id: z.string().min(1) }),
    ]),
  })
);

export class AllocationLoadError extends Error {
  constructor(
    readonly reason: string,
    readonly key: string
  ) {
    super(`Allocation load failed: ${reason} (${key})`);
    this.name = 'AllocationLoadError';
  }
}

export type AllocationControllerDeps = {
  storage: CanonicalStorage;
  /** Injected clock; callers may override per dispatch for determinism. */
  now?: () => number;
  /** Legacy-migration flag for a first-boot record. */
  resumable?: boolean;
  receiptsKey?: string;
  /**
   * The single impure owner of the recovery episode id: mints one uuid for a
   * recovery-opening event that lacks one. Defaults to `crypto.randomUUID`.
   */
  mintEpisodeId?: () => string;
};

export type AllocationDecision = {
  state: AllocationRecord;
  commands: Command[];
  deadlineAt: number | null;
};

export type AllocationController = {
  load(): Promise<AllocationRecord>;
  dispatch(event: AllocationInputEvent, now?: number): Promise<AllocationDecision | undefined>;
  bindAcquisition(
    record: AllocationRecord,
    acquisition: AllocationAcquisition,
    now?: number
  ): Promise<boolean>;
};

/** `stopped` has no identity; otherwise the intent id, then the provider ref. */
export function allocationIdentity(record: AllocationRecord): AllocationIdentity | undefined {
  if (record.state.kind === 'stopped') return undefined;
  const createIntent = record.state.createIntent;
  if (createIntent !== null) return { kind: 'intent', id: createIntent.intentId };
  const providerRef = record.state.target?.providerRef ?? null;
  return providerRef === null ? undefined : { kind: 'provider', id: providerRef };
}

/** A live allocation accepts reuse: creating or allocated, with no stop tombstone. */
export function isLiveAllocation(record: AllocationRecord): boolean {
  return record.state.kind === 'creating' || record.state.kind === 'allocated';
}

/**
 * Attach the minted episode id at the single impure dispatch boundary. Only the
 * four recovery-opening event variants are touched, and only when they lack an
 * id, so a retried dispatch of the same event keeps the first id and every
 * attempt in the episode reuses it.
 */
function withEpisodeId(event: AllocationInputEvent, mint: () => string): AllocationInputEvent {
  switch (event.type) {
    case 'CONNECTED':
    case 'HEARTBEAT':
    case 'HEALTH_OBSERVED':
    case 'DEADLINE':
      return event.episodeId !== undefined ? event : { ...event, episodeId: mint() };
    default:
      return event;
  }
}

export function createAllocationController(deps: AllocationControllerDeps): AllocationController {
  const clock = deps.now ?? (() => Date.now());
  const receiptsKey = deps.receiptsKey ?? ACQUISITION_RECEIPTS_KEY;
  const mintEpisodeId = deps.mintEpisodeId ?? (() => crypto.randomUUID());

  async function load(): Promise<AllocationRecord> {
    const result = await loadAllocation(deps.storage, deps.resumable ?? false);
    if (!result.ok) throw new AllocationLoadError(result.reason, result.key);
    return result.value;
  }

  return {
    load,

    async dispatch(event, now) {
      const at = now ?? clock();
      const record = await load();
      const decision = decideAllocation(record, withEpisodeId(event, mintEpisodeId), at);
      if (decision === undefined) return undefined;
      await storeAllocation(deps.storage, decision.state);
      return {
        state: decision.state,
        commands: decision.commands,
        deadlineAt: decision.deadlineAt,
      };
    },

    async bindAcquisition(record, acquisition, now) {
      const at = now ?? clock();
      if (at >= acquisition.deadlineAt) throw new Error('Sandbox acquisition expired');

      const raw = await deps.storage.get<unknown>(receiptsKey);
      const stored = raw === undefined ? [] : acquisitionReceiptsSchema.parse(raw);
      const receipts = stored.filter(receipt => receipt.deadlineAt > at);
      const receipt = stored.find(candidate => candidate.id === acquisition.id);
      const identity = allocationIdentity(record);
      if (receipt) {
        if (receipt.deadlineAt !== acquisition.deadlineAt) {
          throw new Error('Sandbox acquisition deadline changed');
        }
        if (
          !identity ||
          receipt.allocation.kind !== identity.kind ||
          receipt.allocation.id !== identity.id
        ) {
          throw new SandboxAcquisitionLostError();
        }
      }
      const available = isLiveAllocation(record);
      if (!receipt && available) {
        if (!identity) throw new Error('Sandbox allocation identity is unavailable');
        receipts.push({ ...acquisition, allocation: identity });
      }
      if (receipts.length !== stored.length || (!receipt && available)) {
        await deps.storage.put(receiptsKey, receipts);
      }
      return receipt !== undefined || available;
    },
  };
}
