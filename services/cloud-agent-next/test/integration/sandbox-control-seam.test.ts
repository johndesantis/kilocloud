import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createMemoryProviderAdapter } from '../../src/sandbox-control/provider.js';
import { encodeCloudflareProviderRef } from '../../src/sandbox-control/cloudflare-provider.js';
import { attachRoute, emptyRouteTable } from '../../src/sandbox-control/session-routes.js';
import { saveRouteTable } from '../../src/sandbox-control/durable-state.js';
import { callbackOutboxKey } from '../../src/sandbox-session/message-callbacks.js';
import { getSandboxSessionStub } from '../../src/sandbox-session/session-stub.js';
import type { StopProof } from '../../src/sandbox-state/model/allocation.js';
import {
  readCanonicalAllocationRecord,
  readRawSessionMessages,
  writeSessionMessages,
} from '../../src/sandbox-state/persist/access.js';
import { seedCanonicalRunning } from './canonical-allocation-fixtures.js';

const ownerId = 'user_control_seam';
const kiloToken = 'control-seam-kilo-token';
const ATTACHED_SESSION_KEY = 'terminal_attached_session';

type SeamIds = {
  sessionId: string;
  kiloSessionId: string;
  sandboxId: string;
  wrapperInstanceId: string;
  directory: string;
};

function makeIds(): SeamIds {
  const identity = crypto.randomUUID();
  return {
    sessionId: `workspace_${identity}`,
    kiloSessionId: `ses_${identity.replaceAll('-', '').slice(0, 26)}`,
    sandboxId: `ses-${identity.replaceAll('-', '')}`,
    wrapperInstanceId: crypto.randomUUID(),
    directory: `/workspace/seam/${identity}`,
  };
}

async function registerSeamSession(
  ids: SeamIds,
  options: { sandboxProvider?: string; callbackUrl?: string } = {}
) {
  const stub = getSandboxSessionStub(env, ownerId, ids.sessionId);
  await runInDurableObject(stub, async instance => {
    const result = await instance.registerSession({
      identity: { sessionId: ids.sessionId, userId: ownerId, createdOnPlatform: 'cloud-agent-web' },
      auth: { kiloSessionId: ids.kiloSessionId, kilocodeToken: kiloToken },
      agent: { mode: 'code', model: 'test-model' },
      workspace: {
        sandboxId: ids.sandboxId,
        sandboxProvider: options.sandboxProvider ?? 'cloudflare',
      },
      ...(options.callbackUrl ? { callback: { target: { url: options.callbackUrl } } } : {}),
    });
    expect(result.success).toBe(true);
  });
  return stub;
}

function acceptedRow(ids: SeamIds, messageId: string) {
  return {
    messageId,
    state: 'accepted',
    prompt: 'held turn',
    wrapperInstanceId: ids.wrapperInstanceId,
    acceptedAt: Date.now(),
    lastActivityAt: Date.now(),
  };
}

function stopProof(ids: SeamIds, incarnation: string): StopProof {
  return {
    effect: 'destroy',
    at: Date.now(),
    providerRef: encodeCloudflareProviderRef({
      sandboxId: ids.sandboxId,
      containment: true,
      instanceId: incarnation,
    }),
    incarnation,
    reason: 'idle',
    wrapper: ids.wrapperInstanceId,
  };
}

type AttachmentOverrides = {
  wrapperInstanceId?: string;
  allocationIncarnation?: string;
};

async function seedLegacyAttachment(
  session: Awaited<ReturnType<typeof registerSeamSession>>,
  ids: SeamIds,
  messageId: string,
  overrides: AttachmentOverrides = {}
): Promise<void> {
  await runInDurableObject(session, async (_instance, state) => {
    writeSessionMessages(state.storage, [acceptedRow(ids, messageId)]);
    await state.storage.put(ATTACHED_SESSION_KEY, {
      ownerId,
      sessionId: ids.sessionId,
      kiloSessionId: ids.kiloSessionId,
      directory: ids.directory,
      sandboxId: ids.sandboxId,
      wrapperInstanceId: overrides.wrapperInstanceId ?? ids.wrapperInstanceId,
      ...(overrides.allocationIncarnation !== undefined
        ? { allocationIncarnation: overrides.allocationIncarnation }
        : {}),
    });
  });
}

type SessionStopSeam = {
  notifyStopped(input: { stopProof: StopProof | undefined; reason: string }): Promise<{
    outcome: 'delivered' | 'failed';
    reason?: string;
  }>;
};

/** Count terminal callback/report repairs scheduled by the session seam. */
async function countRepairs(
  session: Awaited<ReturnType<typeof registerSeamSession>>,
  notify: (instance: SessionStopSeam) => Promise<void>
): Promise<{ callbacks: number; reports: number }> {
  return runInDurableObject(session, async instance => {
    const prototype = Object.getPrototypeOf(instance) as {
      scheduleCallbackRepair: () => void;
      scheduleReportRepair: () => void;
    };
    const callbacks = vi.spyOn(prototype, 'scheduleCallbackRepair');
    const reports = vi.spyOn(prototype, 'scheduleReportRepair');
    await notify(instance as unknown as SessionStopSeam);
    return { callbacks: callbacks.mock.calls.length, reports: reports.mock.calls.length };
  });
}

describe('sandbox control seam (live wiring)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('terminalizes a bound session exactly once and clears the binding', async () => {
    const ids = makeIds();
    const messageId = 'msg_seam_exactly_once';
    const session = await registerSeamSession(ids);
    const incarnation = 'incarnation-seam-1';
    await runInDurableObject(session, async (_instance, state) => {
      writeSessionMessages(state.storage, [acceptedRow(ids, messageId)]);
      await state.storage.put(ATTACHED_SESSION_KEY, {
        ownerId,
        sessionId: ids.sessionId,
        kiloSessionId: ids.kiloSessionId,
        directory: ids.directory,
        sandboxId: ids.sandboxId,
        wrapperInstanceId: ids.wrapperInstanceId,
        allocationIncarnation: incarnation,
      });
    });

    await runInDurableObject(session, async instance => {
      const proof = stopProof(ids, incarnation);
      await expect(instance.notifyStopped({ reason: 'idle', stopProof: proof })).resolves.toEqual({
        outcome: 'delivered',
      });
      // A replayed confirmation must not terminalize twice.
      await instance.notifyStopped({ reason: 'idle', stopProof: proof });
    });

    await runInDurableObject(session, async (_instance, state) => {
      const messages = readRawSessionMessages<Record<string, unknown>>(state.storage.kv);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ state: 'failed', failedReason: 'idle' });
      expect(await state.storage.get(ATTACHED_SESSION_KEY)).toBeUndefined();
    });
  });

  it('schedules exactly one terminal callback/report repair across a replay', async () => {
    const ids = makeIds();
    const session = await registerSeamSession(ids);
    const incarnation = 'incarnation-seam-count';
    await seedLegacyAttachment(session, ids, 'msg_seam_count', {
      allocationIncarnation: incarnation,
    });

    const repairs = await countRepairs(session, async instance => {
      const proof = stopProof(ids, incarnation);
      await expect(instance.notifyStopped({ reason: 'idle', stopProof: proof })).resolves.toEqual({
        outcome: 'delivered',
      });
      await instance.notifyStopped({ reason: 'idle', stopProof: proof });
    });
    // No callback target is configured, so the terminal report repair is the
    // observable terminal event; it is scheduled exactly once across the replay.
    expect(repairs).toEqual({ callbacks: 0, reports: 1 });
  });

  it('persists and schedules a configured terminal callback across a replay', async () => {
    const ids = makeIds();
    const messageId = 'msg_seam_callback';
    const session = await registerSeamSession(ids, {
      callbackUrl: 'https://example.com/callback',
    });
    const incarnation = 'incarnation-seam-callback';
    await seedLegacyAttachment(session, ids, messageId, { allocationIncarnation: incarnation });

    const repairs = await countRepairs(session, async instance => {
      const proof = stopProof(ids, incarnation);
      await expect(instance.notifyStopped({ reason: 'idle', stopProof: proof })).resolves.toEqual({
        outcome: 'delivered',
      });
      await instance.notifyStopped({ reason: 'idle', stopProof: proof });
    });
    // A configured callback target turns the terminalization into a persisted
    // callback job, scheduled exactly once across the replay.
    expect(repairs).toEqual({ callbacks: 1, reports: 1 });
    await runInDurableObject(session, async (_instance, state) => {
      const pending = state.storage.kv.get(callbackOutboxKey(messageId)) as
        | { job: { target: { url: string }; payload: { status: string } } }
        | undefined;
      expect(pending?.job.target.url).toBe('https://example.com/callback');
      expect(pending?.job.payload.status).toBe('failed');
    });
  });

  it('rejects a stale incarnation without terminalizing the session', async () => {
    const ids = makeIds();
    const messageId = 'msg_seam_stale';
    const session = await registerSeamSession(ids);
    const incarnation = 'incarnation-seam-2';
    await runInDurableObject(session, async (_instance, state) => {
      writeSessionMessages(state.storage, [acceptedRow(ids, messageId)]);
      await state.storage.put(ATTACHED_SESSION_KEY, {
        ownerId,
        sessionId: ids.sessionId,
        kiloSessionId: ids.kiloSessionId,
        directory: ids.directory,
        sandboxId: ids.sandboxId,
        wrapperInstanceId: ids.wrapperInstanceId,
        allocationIncarnation: incarnation,
      });
    });

    await runInDurableObject(session, async instance => {
      await instance.notifyStopped({
        reason: 'idle',
        stopProof: stopProof(ids, 'incarnation-stale'),
      });
    });

    await runInDurableObject(session, async (_instance, state) => {
      expect(readRawSessionMessages(state.storage.kv)[0]).toMatchObject({ state: 'accepted' });
      expect(await state.storage.get(ATTACHED_SESSION_KEY)).toBeDefined();
    });
  });

  it.each(['cancel', 'idle'] as const)(
    'notifies attached sessions immediately on %s while provider stop is pending, exactly once',
    async reason => {
      const ids = makeIds();
      const messageId = `msg_seam_${reason}`;
      const session = await registerSeamSession(ids);

      const controlStub = env.SANDBOX_CONTROL.getByName(ids.sandboxId);
      let releaseStop: () => void = () => undefined;
      const stopGate = new Promise<void>(resolve => {
        releaseStop = resolve;
      });
      let stopping: Promise<unknown> | undefined;
      const incarnation = await runInDurableObject(controlStub, async (instance, state) => {
        const provider = createMemoryProviderAdapter();
        const originalStop = provider.stop.bind(provider);
        provider.stop = async (ref, intent) => {
          await stopGate;
          return originalStop(ref, intent);
        };
        Object.assign(instance, {
          provider,
          createProviderAdapter: () => provider,
          providerKind: 'cloudflare',
        });
        await instance.initializeOwner(ownerId);
        const providerRef = encodeCloudflareProviderRef({
          sandboxId: ids.sandboxId,
          containment: true,
          instanceId: 'cancel-intent',
        });
        await seedCanonicalRunning(state.storage, providerRef, {
          provider: 'cloudflare',
          intentId: `${reason}-intent`,
          allocationName: ids.sandboxId,
          health: 'healthy',
          // The idle case must stop through the canonical idle deadline, not a
          // direct `beginStop`.
          ...(reason === 'idle' ? { idleAt: Date.now() - 1 } : {}),
        });
        const record = await readCanonicalAllocationRecord(state.storage);
        if (record?.state.kind !== 'allocated') throw new Error('Missing allocated fixture');
        return record.state.health.incarnation;
      });

      await runInDurableObject(session, async (_instance, state) => {
        writeSessionMessages(state.storage, [acceptedRow(ids, messageId)]);
        await state.storage.put(ATTACHED_SESSION_KEY, {
          ownerId,
          sessionId: ids.sessionId,
          kiloSessionId: ids.kiloSessionId,
          directory: ids.directory,
          sandboxId: ids.sandboxId,
          wrapperInstanceId: ids.wrapperInstanceId,
          allocationIncarnation: incarnation,
        });
      });

      let callbacks = 0;
      let reports = 0;
      await runInDurableObject(session, instance => {
        const prototype = Object.getPrototypeOf(instance) as {
          scheduleCallbackRepair: () => void;
          scheduleReportRepair: () => void;
        };
        vi.spyOn(prototype, 'scheduleCallbackRepair').mockImplementation(() => {
          callbacks += 1;
        });
        vi.spyOn(prototype, 'scheduleReportRepair').mockImplementation(() => {
          reports += 1;
        });
      });

      await runInDurableObject(controlStub, async (instance, state) => {
        const table = emptyRouteTable();
        attachRoute(
          table,
          {
            sessionId: ids.sessionId,
            kiloSessionId: ids.kiloSessionId,
            directory: ids.directory,
            ownerId,
          },
          ownerId
        );
        await saveRouteTable(state.storage, table);
        stopping = reason === 'idle' ? instance.alarm() : instance.beginStop(reason);
      });

      // The notification reaches the session before the provider stop resolves.
      await vi.waitFor(async () => {
        const messages = await runInDurableObject(session, async (_instance, sessionState) =>
          readRawSessionMessages<Record<string, unknown>>(sessionState.storage.kv)
        );
        expect(messages[0]).toMatchObject({ state: 'failed', failedReason: reason });
      });

      releaseStop();
      await stopping;
      await runInDurableObject(controlStub, async instance => {
        await instance.confirmStopped();
      });

      // The confirmation replays the notification; terminalization and its
      // callback/report repair happen exactly once.
      await runInDurableObject(session, async (_instance, state) => {
        const messages = readRawSessionMessages<Record<string, unknown>>(state.storage.kv);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ state: 'failed', failedReason: reason });
        expect(await state.storage.get(ATTACHED_SESSION_KEY)).toBeUndefined();
      });
      // One terminal report repair; the confirmation replay adds none.
      expect({ callbacks, reports }).toEqual({ callbacks: 0, reports: 1 });
    }
  );

  it('discards a delayed legacy resolution after the attachment is rebound', async () => {
    const ids = makeIds();
    const messageId = 'msg_seam_delayed_rebind';
    const session = await registerSeamSession(ids);
    await seedLegacyAttachment(session, ids, messageId);

    await runInDurableObject(session, async (instance, state) => {
      const gate = Promise.withResolvers<void>();
      const prototype = Object.getPrototypeOf(instance) as {
        resolveLegacyStopAttachment: () => Promise<unknown>;
      };
      let began: () => void = () => undefined;
      const started = new Promise<void>(resolve => {
        began = resolve;
      });
      vi.spyOn(prototype, 'resolveLegacyStopAttachment').mockImplementationOnce(async () => {
        began();
        await gate.promise;
        return { kind: 'settle' };
      });

      const notified = instance.notifyStopped({
        reason: 'idle',
        stopProof: stopProof(ids, 'stale-incarnation'),
      });
      await started;
      // Concurrent rebind to a different wrapper while the resolver is in flight.
      await state.storage.put(ATTACHED_SESSION_KEY, {
        ownerId,
        sessionId: ids.sessionId,
        kiloSessionId: ids.kiloSessionId,
        directory: ids.directory,
        sandboxId: ids.sandboxId,
        wrapperInstanceId: 'rebound-wrapper',
      });
      gate.resolve();
      await notified;

      // The stale resolver result is discarded: the new binding is intact and
      // the accepted row was not terminalized.
      expect(readRawSessionMessages(state.storage.kv)[0]).toMatchObject({ state: 'accepted' });
      expect(await state.storage.get(ATTACHED_SESSION_KEY)).toMatchObject({
        wrapperInstanceId: 'rebound-wrapper',
      });
    });
  });

  it('retries an unresolved legacy resolution without clearing the attachment', async () => {
    const ids = makeIds();
    const messageId = 'msg_seam_unresolved_retry';
    const session = await registerSeamSession(ids);
    const controlStub = env.SANDBOX_CONTROL.getByName(ids.sandboxId);
    await seedLegacyAttachment(session, ids, messageId);

    // A live incarnation with no exposed wrapper is indeterminate: the resolver
    // must not invent a match and must report a retryable failure.
    await runInDurableObject(controlStub, instance => {
      const prototype = Object.getPrototypeOf(instance) as { getStatus: () => Promise<unknown> };
      vi.spyOn(prototype, 'getStatus').mockResolvedValueOnce({
        allocationIncarnation: 'live-incarnation',
      } as never);
    });

    const first = await runInDurableObject(session, instance =>
      instance.notifyStopped({ reason: 'idle', stopProof: stopProof(ids, 'retry-incarnation') })
    );
    expect(first).toEqual({ outcome: 'failed', reason: 'stop_attachment_unresolved' });
    await runInDurableObject(session, async (_instance, state) => {
      expect(readRawSessionMessages(state.storage.kv)[0]).toMatchObject({ state: 'accepted' });
      expect(await state.storage.get(ATTACHED_SESSION_KEY)).toBeDefined();
    });

    // A re-delivery with the control reachable settles the same legacy record.
    const second = await runInDurableObject(session, instance =>
      instance.notifyStopped({ reason: 'idle', stopProof: stopProof(ids, 'retry-incarnation') })
    );
    expect(second).toEqual({ outcome: 'delivered' });
    await runInDurableObject(session, async (_instance, state) => {
      expect(readRawSessionMessages(state.storage.kv)[0]).toMatchObject({
        state: 'failed',
        failedReason: 'idle',
      });
      expect(await state.storage.get(ATTACHED_SESSION_KEY)).toBeUndefined();
    });
  });

  it('rejects a stale proof against a concurrently hydrated binding', async () => {
    const ids = makeIds();
    const messageId = 'msg_seam_held_hydrate';
    const session = await registerSeamSession(ids);
    await seedLegacyAttachment(session, ids, messageId);

    await runInDurableObject(session, async (instance, state) => {
      const gate = Promise.withResolvers<void>();
      const prototype = Object.getPrototypeOf(instance) as {
        resolveLegacyStopAttachment: () => Promise<unknown>;
      };
      let began: () => void = () => undefined;
      const started = new Promise<void>(resolve => {
        began = resolve;
      });
      vi.spyOn(prototype, 'resolveLegacyStopAttachment').mockImplementationOnce(async () => {
        began();
        await gate.promise;
        return { kind: 'hydrate', incarnation: 'old-incarnation' };
      });

      const notified = instance.notifyStopped({
        reason: 'idle',
        stopProof: stopProof(ids, 'old-incarnation'),
      });
      await started;
      // A concurrent credential-refresh attachment hydrates a *new* incarnation.
      await state.storage.put(ATTACHED_SESSION_KEY, {
        ownerId,
        sessionId: ids.sessionId,
        kiloSessionId: ids.kiloSessionId,
        directory: ids.directory,
        sandboxId: ids.sandboxId,
        wrapperInstanceId: ids.wrapperInstanceId,
        allocationIncarnation: 'new-incarnation',
      });
      gate.resolve();
      await notified;

      // The proof is fenced by the current incarnation, so the fresh binding and
      // its accepted row are untouched.
      expect(readRawSessionMessages(state.storage.kv)[0]).toMatchObject({ state: 'accepted' });
      expect(await state.storage.get(ATTACHED_SESSION_KEY)).toMatchObject({
        allocationIncarnation: 'new-incarnation',
      });
    });
  });

  it('keeps the binding when the stop write is rejected for the current epoch', async () => {
    const ids = makeIds();
    const session = await registerSeamSession(ids);
    const controlStub = env.SANDBOX_CONTROL.getByName(ids.sandboxId);
    await seedLegacyAttachment(session, ids, 'msg_seam_epoch_reject');

    await runInDurableObject(controlStub, instance => {
      const prototype = Object.getPrototypeOf(instance) as { getStatus: () => Promise<unknown> };
      // An incarnation-less legacy binding against an allocation with no exposed
      // incarnation settles through the resolver.
      vi.spyOn(prototype, 'getStatus').mockResolvedValueOnce({} as never);
    });

    await runInDurableObject(session, async instance => {
      const prototype = Object.getPrototypeOf(instance) as {
        saveMessagesInCurrentTransaction: (...args: unknown[]) => boolean;
      };
      // Simulate a concurrent lifecycle advance: the writer rejects the commit
      // for the epoch this notification captured.
      vi.spyOn(prototype, 'saveMessagesInCurrentTransaction').mockReturnValueOnce(false);
      await expect(
        instance.notifyStopped({ reason: 'idle', stopProof: undefined })
      ).resolves.toEqual({ outcome: 'failed', reason: 'stop_commit_rejected' });
    });

    await runInDurableObject(session, async (_instance, state) => {
      // A rejected write must not orphan the binding or terminalize the row.
      expect(readRawSessionMessages(state.storage.kv)[0]).toMatchObject({ state: 'accepted' });
      expect(await state.storage.get(ATTACHED_SESSION_KEY)).toBeDefined();
    });
  });

  it('discards a delayed settlement after the attachment is deleted', async () => {
    const ids = makeIds();
    const session = await registerSeamSession(ids);
    await seedLegacyAttachment(session, ids, 'msg_seam_delayed_delete');

    await runInDurableObject(session, async (instance, state) => {
      const gate = Promise.withResolvers<void>();
      const prototype = Object.getPrototypeOf(instance) as {
        resolveLegacyStopAttachment: () => Promise<unknown>;
      };
      let began: () => void = () => undefined;
      const started = new Promise<void>(resolve => {
        began = resolve;
      });
      vi.spyOn(prototype, 'resolveLegacyStopAttachment').mockImplementationOnce(async () => {
        began();
        await gate.promise;
        return { kind: 'settle' };
      });

      const notified = instance.notifyStopped({ reason: 'idle', stopProof: undefined });
      await started;
      // Concurrent deletion removes the binding while the resolver is in flight.
      await state.storage.delete(ATTACHED_SESSION_KEY);
      gate.resolve();
      await notified;

      expect(readRawSessionMessages(state.storage.kv)[0]).toMatchObject({ state: 'accepted' });
      expect(await state.storage.get(ATTACHED_SESSION_KEY)).toBeUndefined();
    });
  });
});
