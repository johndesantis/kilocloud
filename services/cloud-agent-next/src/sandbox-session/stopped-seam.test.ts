import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoppedEvent } from '../sandbox-state/events.js';
import { decideStopped, settleStopped, type StoppedAttachment } from './stopped-seam.js';

const NOW = 1_000_000;
const INC = 'inc-1';

const ATTACHMENT: StoppedAttachment = {
  allocationIncarnation: INC,
  wrapperInstanceId: 'w-1',
};

const EVENT: StoppedEvent = {
  type: 'STOPPED',
  proof: {
    effect: 'destroy',
    at: NOW,
    providerRef: 'ref-1',
    incarnation: INC,
    reason: 'idle',
  },
  reason: 'allocation_stopped',
};

function queuedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: 'm1',
    state: 'queued',
    deliveryDeadlineAt: NOW + 1_000,
    wrapperInstanceId: 'w-1',
    ...overrides,
  };
}

function acceptedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: 'm2',
    state: 'accepted',
    acceptedAt: NOW - 100,
    executionDeadlineAt: NOW + 1_000,
    wrapperInstanceId: 'w-1',
    preparationAttemptId: 'prep-1',
    preparationWait: { step: 'attach', message: 'waiting' },
    retryNotBefore: NOW,
    unresolvedDispatch: true,
    cancellation: { operationId: 'cancel-1', deadlineAt: NOW + 10 },
    ...overrides,
  };
}

const completedRow = {
  messageId: 'm3',
  state: 'completed',
  terminalAt: NOW - 50,
  terminalSource: 'coordinator',
};

describe('stopped seam — fenced decision', () => {
  it('terminalizes a queued-only bound session the row-derived binding would reject', () => {
    const result = decideStopped({
      rows: [queuedRow()],
      attachment: ATTACHMENT,
      event: EVENT,
      now: NOW,
    });
    expect(result.outcome).toBe('terminalized');
    if (result.outcome !== 'terminalized') return;
    expect(result.clear).toEqual(['attachment', 'nativeRuntimeFence']);
    expect(result.rows[0]).toMatchObject({
      messageId: 'm1',
      state: 'failed',
      failedReason: 'allocation_stopped',
      terminalAt: NOW,
      terminalSource: 'coordinator',
    });
    expect(result.rows[0]?.wrapperInstanceId).toBeUndefined();
  });

  it('terminalizes an accepted row and clears every delivery field', () => {
    const result = decideStopped({
      rows: [acceptedRow()],
      attachment: ATTACHMENT,
      event: EVENT,
      now: NOW,
    });
    expect(result.outcome).toBe('terminalized');
    if (result.outcome !== 'terminalized') return;
    const row = result.rows[0]!;
    expect(row.state).toBe('failed');
    expect(row.failedReason).toBe('allocation_stopped');
    for (const field of [
      'wrapperInstanceId',
      'preparationAttemptId',
      'preparationWait',
      'retryNotBefore',
      'unresolvedDispatch',
      'cancellation',
    ]) {
      expect(row[field], field).toBeUndefined();
    }
  });

  it('terminalizes a terminal-only bound session without changing its rows', () => {
    const result = decideStopped({
      rows: [completedRow],
      attachment: ATTACHMENT,
      event: EVENT,
      now: NOW,
    });
    expect(result).toEqual({
      outcome: 'terminalized',
      rows: [completedRow],
      clear: ['attachment', 'nativeRuntimeFence'],
    });
  });

  it('terminalizes an empty-message bound session', () => {
    expect(decideStopped({ rows: [], attachment: ATTACHMENT, event: EVENT, now: NOW })).toEqual({
      outcome: 'terminalized',
      rows: [],
      clear: ['attachment', 'nativeRuntimeFence'],
    });
  });

  it('terminalizes once and rejects a replay after the attachment is cleared', () => {
    const first = decideStopped({
      rows: [queuedRow(), acceptedRow()],
      attachment: ATTACHMENT,
      event: EVENT,
      now: NOW,
    });
    expect(first.outcome).toBe('terminalized');
    if (first.outcome !== 'terminalized') return;
    expect(first.rows.map(row => row.state)).toEqual(['failed', 'failed']);

    // The clearest binding is gone, so the replayed proof cannot terminalize
    // again; the already-terminal rows keep their first terminal timestamps.
    const replayed = decideStopped({
      rows: first.rows,
      attachment: undefined,
      event: EVENT,
      now: NOW + 5_000,
    });
    expect(replayed).toEqual({ outcome: 'rejected' });
    expect(first.rows.map(row => row.terminalAt)).toEqual([NOW, NOW]);
  });

  it('does not terminalize fresh demand under an old proof, but a matching new proof does', () => {
    const freshRows = [queuedRow({ messageId: 'fresh', wrapperInstanceId: 'w-new' })];
    const freshAttachment: StoppedAttachment = {
      allocationIncarnation: 'inc-new',
      wrapperInstanceId: 'w-new',
    };
    const stale: StoppedEvent = {
      ...EVENT,
      proof: { ...EVENT.proof, incarnation: 'inc-old' },
    };
    expect(
      decideStopped({ rows: freshRows, attachment: freshAttachment, event: stale, now: NOW })
    ).toEqual({ outcome: 'rejected' });

    const matching: StoppedEvent = {
      ...EVENT,
      proof: { ...EVENT.proof, incarnation: 'inc-new', wrapper: 'w-new' },
    };
    const result = decideStopped({
      rows: freshRows,
      attachment: freshAttachment,
      event: matching,
      now: NOW,
    });
    expect(result.outcome).toBe('terminalized');
    if (result.outcome !== 'terminalized') return;
    expect(result.rows[0]).toMatchObject({ messageId: 'fresh', state: 'failed' });
  });

  it('rejects a stale incarnation', () => {
    expect(
      decideStopped({
        rows: [queuedRow()],
        attachment: { allocationIncarnation: 'inc-2', wrapperInstanceId: 'w-1' },
        event: EVENT,
        now: NOW,
      })
    ).toEqual({ outcome: 'rejected' });
  });

  it('rejects a mismatched proof wrapper', () => {
    const stale: StoppedEvent = { ...EVENT, proof: { ...EVENT.proof, wrapper: 'w-9' } };
    expect(
      decideStopped({ rows: [queuedRow()], attachment: ATTACHMENT, event: stale, now: NOW })
    ).toEqual({ outcome: 'rejected' });
  });

  it('rejects an unfenceable record without an incarnation', () => {
    const noIncarnation: StoppedAttachment = { wrapperInstanceId: 'w-1' };
    expect(
      decideStopped({
        rows: [acceptedRow()],
        attachment: noIncarnation,
        event: EVENT,
        now: NOW,
      })
    ).toEqual({ outcome: 'rejected' });
    expect(
      decideStopped({
        rows: [completedRow],
        attachment: noIncarnation,
        event: EVENT,
        now: NOW,
      })
    ).toEqual({ outcome: 'rejected' });
  });

  it('fails closed on malformed rows', () => {
    for (const rows of [
      undefined,
      { messageId: 'm1', state: 'queued' },
      [{ messageId: 'm1', state: 'bogus' }],
      [{ messageId: 'm1', state: 'queued', v: 2 }],
    ]) {
      expect(decideStopped({ rows, attachment: ATTACHMENT, event: EVENT, now: NOW })).toEqual({
        outcome: 'rejected',
      });
    }
  });
});

describe('stopped seam — proof-independent settlement', () => {
  it('terminalizes queued and accepted rows without a fence', () => {
    const result = settleStopped({
      rows: [queuedRow(), acceptedRow(), completedRow],
      reason: 'lost',
      now: NOW,
    });
    expect(result.outcome).toBe('settled');
    if (result.outcome !== 'settled') return;
    expect(result.clear).toEqual(['attachment', 'nativeRuntimeFence']);
    expect(result.rows.map(row => row.state)).toEqual(['failed', 'failed', 'completed']);
    expect(result.rows[0]?.failedReason).toBe('lost');
    expect(result.rows[1]?.failedReason).toBe('lost');
  });

  it('fails closed on malformed rows', () => {
    expect(settleStopped({ rows: 'nope', reason: 'lost', now: NOW })).toEqual({
      outcome: 'rejected',
    });
  });
});

describe('stopped seam — quarantine', () => {
  it('never imports the legacy decoder directly', () => {
    const source = readFileSync(join(__dirname, 'stopped-seam.ts'), 'utf-8');
    expect(source).not.toMatch(/from\s+['"][^'"]*persist\/legacy/);
  });
});
