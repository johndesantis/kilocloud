import { describe, expect, it } from 'vitest';
import { decideHealth } from './reduce.js';
import type { HealthState } from '../model/health.js';
import type { RecoveryFence } from '../events.js';
import { operationId } from '../commands.js';
import { POLICY } from '../schedule.js';

const NOW = 2_000_000;
const INC = 'inc-1';
const EPISODE = NOW + POLICY.recoveryDeadlineMs;

/** Fence for the in-flight attempt of the standard episode. */
function fence(attempt: number, overrides: Partial<RecoveryFence> = {}): RecoveryFence {
  return {
    incarnation: INC,
    episode: EPISODE,
    attempt,
    operationId: operationId('reconcile', INC, EPISODE, attempt),
    ...overrides,
  };
}

function connecting(): HealthState {
  return { kind: 'connecting', incarnation: INC, deadlineAt: NOW + POLICY.connectingDeadlineMs };
}

function healthy(lastAt = NOW - 1_000): HealthState {
  return {
    kind: 'healthy',
    incarnation: INC,
    lastHeartbeat: { incarnation: INC, at: lastAt, ready: true },
    deadlineAt: lastAt + POLICY.heartbeatExpiryMs,
  };
}

function recovering(
  step: 'check_sandbox' | 'reconnect_wrapper' = 'check_sandbox',
  attempts = 1
): HealthState {
  return {
    kind: 'recovering',
    incarnation: INC,
    step,
    attempts,
    deadlineAt: NOW + POLICY.recoveryDeadlineMs,
  };
}

function commandKinds(decision: ReturnType<typeof decideHealth>): string[] {
  return decision?.commands.map(command => command.kind) ?? [];
}

describe('health reducer — design §6 transitions', () => {
  it('connecting + CONNECTED ready → healthy', () => {
    const decision = decideHealth(
      connecting(),
      { type: 'CONNECTED', incarnation: INC, at: NOW, ready: true },
      NOW
    );
    expect(decision?.state.kind).toBe('healthy');
    expect(decision?.deadlineAt).toBe(NOW + POLICY.heartbeatExpiryMs);
    expect(decision?.commands).toEqual([]);
  });

  it('connecting + HEARTBEAT not ready → recovering and emits Reconcile', () => {
    const decision = decideHealth(
      connecting(),
      { type: 'HEARTBEAT', incarnation: INC, at: NOW, ready: false },
      NOW
    );
    expect(decision?.state.kind).toBe('recovering');
    expect(decision?.deadlineAt).toBe(NOW + POLICY.recoveryDeadlineMs);
    expect(commandKinds(decision)).toEqual(['Reconcile']);
    const command = decision?.commands[0];
    expect(command?.kind === 'Reconcile' && command.attempt).toBe(1);
    expect(command?.kind === 'Reconcile' && command.deadlineAt).toBe(
      NOW + POLICY.recoveryDeadlineMs
    );
  });

  it('connecting + DEADLINE → recovering with Reconcile', () => {
    const decision = decideHealth(
      connecting(),
      { type: 'DEADLINE' },
      NOW + POLICY.connectingDeadlineMs
    );
    expect(decision?.state.kind).toBe('recovering');
    expect(commandKinds(decision)).toEqual(['Reconcile']);
  });

  it('connecting + HEALTH_OBSERVED terminal → unhealthy absent', () => {
    const decision = decideHealth(
      connecting(),
      { type: 'HEALTH_OBSERVED', incarnation: INC, at: NOW, providerState: 'terminal' },
      NOW
    );
    expect(decision?.state.kind === 'unhealthy' && decision.state.verdict).toBe('absent');
    expect(decision?.deadlineAt).toBeNull();
  });

  it('healthy + HEARTBEAT ready → healthy refreshed', () => {
    const decision = decideHealth(
      healthy(),
      { type: 'HEARTBEAT', incarnation: INC, at: NOW, ready: true },
      NOW
    );
    expect(decision?.state.kind).toBe('healthy');
    expect(decision?.deadlineAt).toBe(NOW + POLICY.heartbeatExpiryMs);
  });

  it('healthy + HEARTBEAT not ready → recovering with Reconcile', () => {
    const decision = decideHealth(
      healthy(),
      { type: 'HEARTBEAT', incarnation: INC, at: NOW, ready: false },
      NOW
    );
    expect(decision?.state.kind).toBe('recovering');
    expect(commandKinds(decision)).toEqual(['Reconcile']);
  });

  it('healthy + DEADLINE → recovering with Reconcile', () => {
    const decision = decideHealth(healthy(), { type: 'DEADLINE' }, NOW + POLICY.heartbeatExpiryMs);
    expect(decision?.state.kind).toBe('recovering');
    expect(commandKinds(decision)).toEqual(['Reconcile']);
  });

  it('healthy + HEALTH_OBSERVED terminal → unhealthy absent', () => {
    const decision = decideHealth(
      healthy(),
      { type: 'HEALTH_OBSERVED', incarnation: INC, at: NOW, providerState: 'terminal' },
      NOW
    );
    expect(decision?.state.kind === 'unhealthy' && decision.state.verdict).toBe('absent');
  });

  it('healthy + HEALTH_OBSERVED unknown → recovering with Reconcile', () => {
    const decision = decideHealth(
      healthy(),
      { type: 'HEALTH_OBSERVED', incarnation: INC, at: NOW, providerState: 'unknown' },
      NOW
    );
    expect(decision?.state.kind).toBe('recovering');
    expect(commandKinds(decision)).toEqual(['Reconcile']);
  });

  it('recovering + RECOVERY_STEP advances and cannot extend the absolute deadline', () => {
    const before = recovering('check_sandbox', 1) as Extract<HealthState, { kind: 'recovering' }>;
    const decision = decideHealth(
      before,
      { type: 'RECOVERY_STEP', fence: fence(2), step: 'reconnect_wrapper' },
      NOW + 5_000
    );
    expect(decision?.state.kind === 'recovering' && decision.state.step).toBe('reconnect_wrapper');
    expect(decision?.state.kind === 'recovering' && decision.state.attempts).toBe(2);
    expect(decision?.deadlineAt).toBe(before.deadlineAt);
    expect(commandKinds(decision)).toEqual(['Reconcile']);
    const command = decision?.commands[0];
    expect(command?.kind === 'Reconcile' && command.deadlineAt).toBe(before.deadlineAt);
    expect(command?.kind === 'Reconcile' && command.attempt).toBe(3);
  });

  it('recovering rejects a backward RECOVERY_STEP', () => {
    expect(
      decideHealth(
        recovering('reconnect_wrapper'),
        { type: 'RECOVERY_STEP', fence: fence(2), step: 'check_sandbox' },
        NOW
      )
    ).toBeUndefined();
  });

  it('recovering rejects a RECOVERY_STEP whose fence does not match the in-flight attempt', () => {
    expect(
      decideHealth(
        recovering('check_sandbox', 1),
        { type: 'RECOVERY_STEP', fence: fence(1), step: 'reconnect_wrapper' },
        NOW
      )
    ).toBeUndefined();
    expect(
      decideHealth(
        recovering('check_sandbox', 1),
        {
          type: 'RECOVERY_STEP',
          fence: fence(2, { episode: EPISODE + 1 }),
          step: 'reconnect_wrapper',
        },
        NOW
      )
    ).toBeUndefined();
    expect(
      decideHealth(
        recovering('check_sandbox', 1),
        {
          type: 'RECOVERY_STEP',
          fence: fence(2, { operationId: 'reconcile:stale' }),
          step: 'reconnect_wrapper',
        },
        NOW
      )
    ).toBeUndefined();
  });

  it('recovering + RECOVERY_SUCCEEDED ready → healthy', () => {
    const decision = decideHealth(
      recovering('check_sandbox', 1),
      { type: 'RECOVERY_SUCCEEDED', fence: fence(2), at: NOW, ready: true },
      NOW
    );
    expect(decision?.state.kind).toBe('healthy');
    expect(decision?.commands).toEqual([]);
  });

  it('recovering rejects RECOVERY_SUCCEEDED with ready false or a stale fence', () => {
    expect(
      decideHealth(
        recovering('check_sandbox', 1),
        { type: 'RECOVERY_SUCCEEDED', fence: fence(2), at: NOW, ready: false },
        NOW
      )
    ).toBeUndefined();
    expect(
      decideHealth(
        recovering('check_sandbox', 1),
        {
          type: 'RECOVERY_SUCCEEDED',
          fence: fence(2, { incarnation: 'other' }),
          at: NOW,
          ready: true,
        },
        NOW
      )
    ).toBeUndefined();
    expect(
      decideHealth(
        recovering('check_sandbox', 1),
        { type: 'RECOVERY_SUCCEEDED', fence: fence(2, { attempt: 1 }), at: NOW, ready: true },
        NOW
      )
    ).toBeUndefined();
  });

  it('budget is consumed by fenced operation completion, not by not-ready heartbeats', () => {
    const notReady = { type: 'HEARTBEAT' as const, incarnation: INC, at: NOW, ready: false };
    let state: HealthState = recovering('check_sandbox', 1);
    // Repeated not-ready heartbeats do not consume budget or re-emit Reconcile.
    for (let i = 0; i < 3; i += 1) {
      const decision = decideHealth(state, notReady, NOW)!;
      expect(decision.state).toEqual(state);
      expect(decision.commands).toEqual([]);
      state = decision.state;
    }
    // A fenced attempt completion consumes exactly one attempt.
    const consumed = decideHealth(
      state,
      { type: 'RECOVERY_ATTEMPT_FAILED', fence: fence(2) },
      NOW
    )!;
    expect(consumed.state.kind === 'recovering' && consumed.state.attempts).toBe(2);
    expect(commandKinds(consumed)).toEqual(['Reconcile']);
    // The next fenced completion reaches the budget and derives exhaustion.
    const exhausted = decideHealth(
      consumed.state,
      { type: 'RECOVERY_ATTEMPT_FAILED', fence: fence(3) },
      NOW
    )!;
    expect(exhausted.state.kind === 'unhealthy' && exhausted.state.verdict).toBe('unresponsive');
    expect(exhausted.commands).toEqual([]);
    expect(exhausted.deadlineAt).toBeNull();
  });

  it('replaying an already-consumed recovery attempt is rejected by the fence', () => {
    const consumed = decideHealth(
      recovering('check_sandbox', 1),
      { type: 'RECOVERY_ATTEMPT_FAILED', fence: fence(2) },
      NOW
    )!;
    expect(
      decideHealth(consumed.state, { type: 'RECOVERY_ATTEMPT_FAILED', fence: fence(2) }, NOW)
    ).toBeUndefined();
  });

  it('a step change at the attempt budget exhausts rather than extending', () => {
    const decision = decideHealth(
      recovering('check_sandbox', POLICY.recoveryMaxAttempts - 1),
      {
        type: 'RECOVERY_STEP',
        fence: fence(POLICY.recoveryMaxAttempts),
        step: 'reconnect_wrapper',
      },
      NOW
    );
    expect(decision?.state.kind === 'unhealthy' && decision.state.verdict).toBe('unresponsive');
    expect(decision?.deadlineAt).toBeNull();
  });

  it('a later recovery episode gets fresh command ids and its own deadline', () => {
    const first = decideHealth(
      connecting(),
      { type: 'HEARTBEAT', incarnation: INC, at: NOW, ready: false },
      NOW
    )!;
    const firstHealth = first.state as Extract<HealthState, { kind: 'recovering' }>;
    const firstCommand = first.commands[0];
    expect(firstCommand?.kind === 'Reconcile' && firstCommand.operationId).toBe(
      operationId('reconcile', INC, firstHealth.deadlineAt, 1)
    );

    const laterAt = NOW + 10_000_000;
    const later = decideHealth(
      connecting(),
      { type: 'HEARTBEAT', incarnation: INC, at: laterAt, ready: false },
      laterAt
    )!;
    const laterHealth = later.state as Extract<HealthState, { kind: 'recovering' }>;
    const laterCommand = later.commands[0];
    expect(laterHealth.deadlineAt).not.toBe(firstHealth.deadlineAt);
    expect(laterCommand?.kind === 'Reconcile' && laterCommand.operationId).not.toBe(
      firstCommand?.kind === 'Reconcile' ? firstCommand.operationId : undefined
    );
  });

  it('recovering + CANCEL{recovery} → unhealthy unresponsive', () => {
    const decision = decideHealth(recovering(), { type: 'CANCEL', scope: 'recovery' }, NOW);
    expect(decision?.state.kind === 'unhealthy' && decision.state.verdict).toBe('unresponsive');
  });

  it('recovering + DEADLINE past the absolute deadline → unhealthy unresponsive', () => {
    const decision = decideHealth(
      recovering(),
      { type: 'DEADLINE' },
      NOW + POLICY.recoveryDeadlineMs
    );
    expect(decision?.state.kind === 'unhealthy' && decision.state.verdict).toBe('unresponsive');
  });

  it('recovering + DEADLINE before the deadline keeps the same deadline', () => {
    const before = recovering();
    const decision = decideHealth(before, { type: 'DEADLINE' }, NOW);
    expect(decision?.state).toEqual(before);
    expect(decision?.deadlineAt).toBe(NOW + POLICY.recoveryDeadlineMs);
  });

  it('evidence is fenced by incarnation: a mismatched heartbeat is dropped', () => {
    expect(
      decideHealth(
        healthy(),
        { type: 'HEARTBEAT', incarnation: 'other', at: NOW, ready: true },
        NOW
      )
    ).toBeUndefined();
  });

  it('unhealthy is terminal and rejects every event', () => {
    const unhealthy: HealthState = { kind: 'unhealthy', incarnation: INC, verdict: 'absent' };
    const events = [
      { type: 'HEARTBEAT' as const, incarnation: INC, at: NOW, ready: true },
      { type: 'CONNECTED' as const, incarnation: INC, at: NOW, ready: true },
      { type: 'RECOVERY_STEP' as const, fence: fence(1), step: 'reconnect_wrapper' as const },
      { type: 'RECOVERY_ATTEMPT_FAILED' as const, fence: fence(1) },
      { type: 'RECOVERY_SUCCEEDED' as const, fence: fence(1), at: NOW, ready: true },
      { type: 'HEALTH_UNHEALTHY' as const, verdict: 'unresponsive' as const },
      { type: 'CANCEL' as const, scope: 'recovery' as const },
      { type: 'DEADLINE' as const },
    ];
    for (const event of events) {
      expect(decideHealth(unhealthy, event, NOW)).toBeUndefined();
    }
  });

  it('carries the terminal verdict into the unhealthy state', () => {
    const absent = decideHealth(healthy(), { type: 'HEALTH_UNHEALTHY', verdict: 'absent' }, NOW);
    const unresponsive = decideHealth(
      healthy(),
      { type: 'HEALTH_UNHEALTHY', verdict: 'unresponsive' },
      NOW
    );
    expect(absent?.state.kind === 'unhealthy' && absent.state.verdict).toBe('absent');
    expect(unresponsive?.state.kind === 'unhealthy' && unresponsive.state.verdict).toBe(
      'unresponsive'
    );
  });
});
