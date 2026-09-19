/**
 * Pure stopped-seam adapter for the allocation→session `STOPPED` event. It derives
 * the canonical aggregate's messages with the frozen legacy row decoder consumed
 * through its permitted boundary (`persist/load.ts`) and derives the binding from
 * the authoritative attachment record independently of row states.
 *
 * The terminalization decision is never re-derived here. The fenced operation
 * takes the canonical decided messages from `decideSession`; the proof-independent
 * settlement calls the canonical `terminalizeOnStop` directly. Both then project
 * the decided messages back onto the preserved legacy rows as a pure
 * representation map, so a change to canonical `STOPPED` semantics governs the
 * returned rows.
 *
 * It does no I/O and holds no storage. It must not import `persist/legacy/`
 * (quarantine) and must not derive the binding with `convertLegacySession(rows,
 * handle)`, which marks a queued-only or idle-but-attached session `unbound`.
 */
import { decideSession, terminalizeOnStop } from '../sandbox-state/session/reduce.js';
import type { StoppedEvent } from '../sandbox-state/events.js';
import type { Binding, MessageState, SessionMessage } from '../sandbox-state/model/session.js';
import { decodeLegacySessionMessages } from '../sandbox-state/persist/load.js';

/** A raw legacy session-message row; unknown fields are preserved verbatim. */
export type StoppedRow = Record<string, unknown>;

/**
 * The authoritative attachment record. `allocationIncarnation` is absent on
 * pre-C3b records, which are resolved before this adapter runs; `undefined`
 * models an already-cleared (duplicate) attachment.
 */
export type StoppedAttachment = {
  allocationIncarnation?: string;
  wrapperInstanceId: string;
};

/** Binding keys the caller clears when the decision terminalizes. */
export type StoppedClearKey = 'attachment' | 'nativeRuntimeFence';

export type StoppedSeamResult =
  | { outcome: 'rejected' }
  | { outcome: 'terminalized'; rows: readonly StoppedRow[]; clear: readonly StoppedClearKey[] };

export type StoppedSettlementResult =
  | { outcome: 'rejected' }
  | { outcome: 'settled'; rows: readonly StoppedRow[]; clear: readonly StoppedClearKey[] };

/** Fields cleared on terminalization so no stale delivery state survives. */
const CLEARED_ROW_FIELDS = [
  'wrapperInstanceId',
  'preparationAttemptId',
  'preparationWait',
  'retryNotBefore',
  'unresolvedDispatch',
  'cancellation',
] as const;

type TerminalMessageState = Extract<MessageState, { kind: 'completed' | 'failed' | 'cancelled' }>;

function isTerminalState(state: MessageState): state is TerminalMessageState {
  return state.kind === 'completed' || state.kind === 'failed' || state.kind === 'cancelled';
}

function bindingForAttachment(
  attachment: StoppedAttachment | undefined,
  messages: readonly SessionMessage[]
): Binding {
  if (attachment?.allocationIncarnation !== undefined) {
    return {
      kind: 'bound',
      handle: {
        incarnation: attachment.allocationIncarnation,
        wrapper: attachment.wrapperInstanceId,
        epoch: 0,
      },
    };
  }
  return messages.some(message => message.state.kind === 'accepted')
    ? { kind: 'unresolved' }
    : { kind: 'unbound' };
}

/** Representation map: write a canonical terminal state onto a preserved row. */
function terminalRow(row: StoppedRow, state: TerminalMessageState): StoppedRow {
  const next: StoppedRow = { ...row };
  for (const field of CLEARED_ROW_FIELDS) delete next[field];
  next.state = state.kind;
  next.terminalAt = state.at;
  next.terminalSource = state.source;
  if (state.kind === 'failed' && state.reason !== undefined) {
    next.failedReason = state.reason;
  } else {
    delete next.failedReason;
  }
  if (state.kind === 'failed' && state.detail !== undefined) {
    next.failedDetail = state.detail;
  } else {
    delete next.failedDetail;
  }
  return next;
}

/**
 * Project the canonical decided messages back onto the preserved rows. Only a row
 * whose canonical state changed to terminal is rewritten; the terminal state,
 * timestamp, source and reason all come from the canonical decision.
 */
function projectTerminalRows(
  rows: readonly StoppedRow[],
  decoded: readonly SessionMessage[],
  decided: readonly SessionMessage[]
): readonly StoppedRow[] {
  return rows.map((row, index) => {
    const before = decoded[index];
    const after = decided[index];
    if (before === undefined || after === undefined) return row;
    if (before.state.kind === after.state.kind) return row;
    return isTerminalState(after.state) ? terminalRow(row, after.state) : row;
  });
}

/**
 * Fenced decision for a matching `STOPPED`. A malformed row set, an unfenceable
 * binding (`unresolved`/`unbound`) or a stale proof returns `rejected`; a
 * duplicate is rejected because the binding has already been cleared.
 */
export function decideStopped(input: {
  rows: unknown;
  attachment: StoppedAttachment | undefined;
  event: StoppedEvent;
  now: number;
}): StoppedSeamResult {
  const { rows, attachment, event, now } = input;
  const messages = decodeLegacySessionMessages(rows);
  if (messages === undefined) return { outcome: 'rejected' };
  const decision = decideSession(
    { binding: bindingForAttachment(attachment, messages), messages },
    event,
    now
  );
  if (decision === undefined) return { outcome: 'rejected' };
  return {
    outcome: 'terminalized',
    rows: projectTerminalRows(rows as readonly StoppedRow[], messages, decision.state.messages),
    clear: ['attachment', 'nativeRuntimeFence'],
  };
}

/**
 * Proof-independent settlement (item 4's settle outcome): terminalize every
 * `queued`/`accepted` row with the loss reason through the canonical operation,
 * without the incarnation fence.
 */
export function settleStopped(input: {
  rows: unknown;
  reason: string;
  now: number;
}): StoppedSettlementResult {
  const messages = decodeLegacySessionMessages(input.rows);
  if (messages === undefined) return { outcome: 'rejected' };
  const settled = terminalizeOnStop(
    { binding: { kind: 'unbound' }, messages },
    input.reason,
    input.now
  );
  return {
    outcome: 'settled',
    rows: projectTerminalRows(input.rows as readonly StoppedRow[], messages, settled.messages),
    clear: ['attachment', 'nativeRuntimeFence'],
  };
}
