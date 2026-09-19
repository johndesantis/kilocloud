/**
 * Canonical loader with the split dispatch from plan §3.
 *
 * Allocation: canonical key present → strict parse or fail closed; absent → decode
 * the legacy allocation record; both absent → the initial record.
 *
 * Session: missing → empty aggregate; marker-free bare array → legacy decode;
 * canonical `{v: 2}` envelope → strict decode; anything else → fail closed.
 *
 * A fail-closed result is a value, not an exception, and performs no destructive
 * action; the caller decides how to surface it.
 */
import {
  allocationRecordSchema,
  initialAllocationRecord,
  type AllocationRecord,
} from '../model/allocation.js';
import {
  emptySessionAggregate,
  sessionEnvelopeSchema,
  type RuntimeHandle,
  type SessionAggregate,
  type SessionMessage,
} from '../model/session.js';
import { decodeLegacyAllocation } from './legacy/allocation.js';
import { decodeLegacySession } from './legacy/session.js';
import { readAllocationEntry, readSessionEntry } from './access.js';
import { ALLOCATION_KEY, type CanonicalStorage } from './store.js';

export type LoadSource = 'canonical' | 'legacy' | 'initial';

export type LoadResult<T> =
  | { ok: true; source: LoadSource; value: T }
  | { ok: false; reason: string; key: string };

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export async function loadAllocation(
  storage: CanonicalStorage,
  resumable = false
): Promise<LoadResult<AllocationRecord>> {
  const raw = await storage.get(ALLOCATION_KEY);
  if (raw !== undefined) {
    const parsed = allocationRecordSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, reason: 'invalid_canonical_allocation', key: ALLOCATION_KEY };
    }
    return { ok: true, source: 'canonical', value: parsed.data };
  }
  const legacy = await readAllocationEntry(storage);
  if (legacy === undefined) {
    return { ok: true, source: 'initial', value: initialAllocationRecord(resumable) };
  }
  const converted = decodeLegacyAllocation(legacy.value);
  if (!converted) {
    return { ok: false, reason: 'invalid_legacy_allocation', key: legacy.key };
  }
  return { ok: true, source: 'legacy', value: converted };
}

/**
 * Optional authoritative migration context for a legacy session. The decoded
 * allocation supplies the handle whose incarnation a real loss proof carries.
 */
export type SessionLoadOptions = {
  legacyBindingHandle?: RuntimeHandle;
};

export async function loadSession(
  storage: CanonicalStorage,
  options: SessionLoadOptions = {}
): Promise<LoadResult<SessionAggregate>> {
  const raw = await readSessionEntry(storage);
  if (raw === undefined) {
    return { ok: true, source: 'initial', value: emptySessionAggregate() };
  }
  const value = raw.value;
  if (Array.isArray(value)) {
    if (hasOwn(value, 'v')) {
      return { ok: false, reason: 'foreign_marker', key: raw.key };
    }
    const converted = decodeLegacySession(value, options.legacyBindingHandle);
    if (!converted) {
      return { ok: false, reason: 'invalid_legacy_session', key: raw.key };
    }
    return { ok: true, source: 'legacy', value: converted };
  }
  if (typeof value === 'object' && value !== null) {
    if (hasOwn(value, 'v') && (value as { v?: unknown }).v !== 2) {
      return { ok: false, reason: 'foreign_marker', key: raw.key };
    }
    const parsed = sessionEnvelopeSchema.safeParse(value);
    if (!parsed.success) {
      return { ok: false, reason: 'invalid_canonical_session', key: raw.key };
    }
    return {
      ok: true,
      source: 'canonical',
      value: { binding: parsed.data.binding, messages: parsed.data.messages },
    };
  }
  return { ok: false, reason: 'invalid_session_shape', key: raw.key };
}

/**
 * Permitted boundary for the stopped-seam adapter: decode the frozen legacy bare
 * array to canonical messages only. The binding is deliberately ignored — the
 * seam derives it from the authoritative attachment record, not from row states.
 */
export function decodeLegacySessionMessages(value: unknown): SessionMessage[] | undefined {
  return decodeLegacySession(value)?.messages;
}
