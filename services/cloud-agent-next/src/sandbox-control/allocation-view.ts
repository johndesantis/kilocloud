/**
 * Read-only canonical→flat projection for the test-support `getPhysicalRecord()`
 * RPC. It is a representation map, never a decision: it is never written and
 * never authoritative, and it dies in C3d once the flat reader is gone.
 *
 * It defines its own result type instead of importing `physical-lifecycle.ts`,
 * so deleting the flat modules cannot break it and it cannot become a second
 * flat writer.
 */
import type {
  AllocationRecord,
  AllocationState,
  AllocationTarget,
  CredentialContainmentRequirements,
  VercelAllocationConfig,
} from '../sandbox-state/model/allocation.js';

export type FlatCredentialContainment = CredentialContainmentRequirements;

export type FlatResolvedContainment = FlatCredentialContainment & { providerRef: string };

export type FlatCreateIntent = {
  intentId: string;
  createdAt: number;
  allocationName?: string;
  vercel?: VercelAllocationConfig;
  containment?: FlatCredentialContainment;
};

export type FlatStopTombstone = {
  reason: string;
  attempts: number;
  createdAt: number;
  wrapperInstanceId?: string;
};

export type FlatAllocationState =
  | 'stopped'
  | 'creating'
  | 'running'
  | 'stopping'
  | 'failed'
  | 'unknown';

export type FlatAllocationRecord = {
  state: FlatAllocationState;
  providerRef: string | null;
  createIntent: FlatCreateIntent | null;
  stopTombstone: FlatStopTombstone | null;
  resumable: boolean;
  containment?: FlatResolvedContainment;
};

function flatCreateIntent(
  state: Exclude<AllocationState, { kind: 'stopped' }>,
  target: AllocationTarget | null
): FlatCreateIntent | null {
  const intent = state.createIntent;
  if (intent === null) return null;
  return {
    intentId: intent.intentId,
    createdAt: intent.createdAt,
    ...(target?.allocationName !== undefined ? { allocationName: target.allocationName } : {}),
    ...(target?.vercel !== undefined ? { vercel: target.vercel } : {}),
    ...(target?.containment !== undefined ? { containment: target.containment } : {}),
  };
}

function flatStopTombstone(
  state: Exclude<AllocationState, { kind: 'stopped' }>
): FlatStopTombstone | null {
  if (state.kind !== 'stopping' && state.kind !== 'unknown') return null;
  const intent = state.stopIntent;
  if (intent === null) return null;
  return {
    reason: intent.reason,
    attempts: state.attempts,
    createdAt: intent.createdAt,
    ...(intent.wrapperInstanceId !== undefined
      ? { wrapperInstanceId: intent.wrapperInstanceId }
      : {}),
  };
}

/**
 * Canonical → flat. `stopped` projects the flat terminal shape (`providerRef`,
 * `createIntent` and `stopTombstone` are all null), exactly as the flat machine's
 * `confirmStopped` produced it.
 *
 * The legacy converter folds flat `failed` into canonical `unknown` with
 * `reason: 'legacy_failed'` (`persist/legacy/allocation.ts`). That marker is the
 * only way to tell the two apart; this is a representation map, not a second
 * transition decision.
 */
export function projectAllocationToFlat(record: AllocationRecord): FlatAllocationRecord {
  const { state } = record;
  if (state.kind === 'stopped') {
    return {
      state: 'stopped',
      providerRef: null,
      createIntent: null,
      stopTombstone: null,
      resumable: record.resumable,
    };
  }
  const target = state.target;
  return {
    state:
      state.kind === 'allocated'
        ? 'running'
        : state.kind === 'creating'
          ? 'creating'
          : state.kind === 'stopping'
            ? 'stopping'
            : state.reason === 'legacy_failed'
              ? 'failed'
              : 'unknown',
    providerRef: target?.providerRef ?? null,
    createIntent: flatCreateIntent(state, target),
    stopTombstone: flatStopTombstone(state),
    resumable: record.resumable,
    ...(target?.resolvedContainment !== undefined
      ? { containment: target.resolvedContainment }
      : {}),
  };
}
