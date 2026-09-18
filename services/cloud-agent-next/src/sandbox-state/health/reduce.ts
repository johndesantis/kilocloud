/**
 * Runtime-health reducer (design §6). Pure: no I/O, no clock read, no storage.
 * `decideHealth(state, event, now)` returns `undefined` when the event is not
 * accepted for the state (an explicit rejection, not a silent no-op).
 *
 * Recovery is owned here: entering or advancing it emits a `Reconcile` command,
 * and the single attempt budget (`recoveryMaxAttempts`) is enforced against the
 * attempts actually recorded, never against a supplied verdict.
 */
import type { Command, Decision } from '../commands.js';
import { operationId } from '../commands.js';
import type { StateMeta, TransitionMeta } from '../registry.js';
import type { HealthEvent, RecoveryFence } from '../events.js';
import type {
  HealthState,
  HeartbeatEvidence,
  HealthRecoveryStep,
  HealthVerdict,
  HealthyHealth,
  RecoveringHealth,
  UnhealthyHealth,
  ConnectingHealth,
} from '../model/health.js';
import { connectingHealth } from '../model/health.js';
import { POLICY } from '../schedule.js';

export const HEALTH = 'health';

export const HEALTH_STATES: readonly StateMeta[] = [
  { kind: 'connecting', terminal: false, hasDeadline: true, namedExits: [] },
  { kind: 'healthy', terminal: false, hasDeadline: true, namedExits: [] },
  { kind: 'recovering', terminal: false, hasDeadline: true, namedExits: [] },
  { kind: 'unhealthy', terminal: true, hasDeadline: false, namedExits: [] },
];

export const HEALTH_EVENT_TYPES = [
  'CONNECTED',
  'HEARTBEAT',
  'HEALTH_OBSERVED',
  'RECOVERY_STEP',
  'RECOVERY_ATTEMPT_FAILED',
  'RECOVERY_SUCCEEDED',
  'HEALTH_UNHEALTHY',
  'CANCEL',
  'DEADLINE',
] as const;

export const HEALTH_TRANSITIONS: readonly TransitionMeta[] = [
  { from: 'connecting', event: 'CONNECTED', to: 'healthy', commands: [], deadline: 'heartbeat' },
  {
    from: 'connecting',
    event: 'CONNECTED',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  { from: 'connecting', event: 'HEARTBEAT', to: 'healthy', commands: [], deadline: 'heartbeat' },
  {
    from: 'connecting',
    event: 'HEARTBEAT',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  { from: 'connecting', event: 'HEALTH_OBSERVED', to: 'unhealthy', commands: [], deadline: null },
  {
    from: 'connecting',
    event: 'HEALTH_OBSERVED',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  {
    from: 'connecting',
    event: 'HEALTH_OBSERVED',
    to: 'connecting',
    commands: [],
    deadline: 'connect',
  },
  { from: 'connecting', event: 'HEALTH_UNHEALTHY', to: 'unhealthy', commands: [], deadline: null },
  { from: 'connecting', event: 'CANCEL', to: 'unhealthy', commands: [], deadline: null },
  {
    from: 'connecting',
    event: 'DEADLINE',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  { from: 'connecting', event: 'DEADLINE', to: 'connecting', commands: [], deadline: 'connect' },

  { from: 'healthy', event: 'CONNECTED', to: 'healthy', commands: [], deadline: 'heartbeat' },
  {
    from: 'healthy',
    event: 'CONNECTED',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  { from: 'healthy', event: 'HEARTBEAT', to: 'healthy', commands: [], deadline: 'heartbeat' },
  {
    from: 'healthy',
    event: 'HEARTBEAT',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  { from: 'healthy', event: 'HEALTH_OBSERVED', to: 'unhealthy', commands: [], deadline: null },
  {
    from: 'healthy',
    event: 'HEALTH_OBSERVED',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  { from: 'healthy', event: 'HEALTH_OBSERVED', to: 'healthy', commands: [], deadline: 'heartbeat' },
  { from: 'healthy', event: 'HEALTH_UNHEALTHY', to: 'unhealthy', commands: [], deadline: null },
  {
    from: 'healthy',
    event: 'DEADLINE',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  { from: 'healthy', event: 'DEADLINE', to: 'healthy', commands: [], deadline: 'heartbeat' },

  {
    from: 'recovering',
    event: 'RECOVERY_STEP',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  { from: 'recovering', event: 'RECOVERY_STEP', to: 'unhealthy', commands: [], deadline: null },
  {
    from: 'recovering',
    event: 'RECOVERY_ATTEMPT_FAILED',
    to: 'recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  {
    from: 'recovering',
    event: 'RECOVERY_ATTEMPT_FAILED',
    to: 'unhealthy',
    commands: [],
    deadline: null,
  },
  { from: 'recovering', event: 'CONNECTED', to: 'healthy', commands: [], deadline: 'heartbeat' },
  { from: 'recovering', event: 'CONNECTED', to: 'recovering', commands: [], deadline: 'recovery' },
  { from: 'recovering', event: 'HEARTBEAT', to: 'healthy', commands: [], deadline: 'heartbeat' },
  {
    from: 'recovering',
    event: 'HEARTBEAT',
    to: 'recovering',
    commands: [],
    deadline: 'recovery',
  },
  {
    from: 'recovering',
    event: 'RECOVERY_SUCCEEDED',
    to: 'healthy',
    commands: [],
    deadline: 'heartbeat',
  },
  { from: 'recovering', event: 'HEALTH_OBSERVED', to: 'unhealthy', commands: [], deadline: null },
  {
    from: 'recovering',
    event: 'HEALTH_OBSERVED',
    to: 'recovering',
    commands: [],
    deadline: 'recovery',
  },
  { from: 'recovering', event: 'HEALTH_UNHEALTHY', to: 'unhealthy', commands: [], deadline: null },
  { from: 'recovering', event: 'CANCEL', to: 'unhealthy', commands: [], deadline: null },
  { from: 'recovering', event: 'DEADLINE', to: 'unhealthy', commands: [], deadline: null },
  { from: 'recovering', event: 'DEADLINE', to: 'recovering', commands: [], deadline: 'recovery' },
];

/** Fields written only by this reducer. */
export const HEALTH_OWNED_FIELDS = [
  'health.kind',
  'health.incarnation',
  'health.lastHeartbeat',
  'health.lastObservation',
  'health.step',
  'health.attempts',
  'health.deadlineAt',
  'health.verdict',
] as const;

const RECOVERY_STEP_ORDER: Record<HealthRecoveryStep, number> = {
  check_sandbox: 0,
  reconnect_wrapper: 1,
};

/** Health-owned constructor: a fresh connecting state with the standard deadline. */
export function connectingAt(incarnation: string, now: number): ConnectingHealth {
  return connectingHealth(incarnation, now + POLICY.connectingDeadlineMs);
}

function matches(state: HealthState, incarnation: string): boolean {
  return state.incarnation === incarnation;
}

function unhealthy(state: HealthState, verdict: HealthVerdict): UnhealthyHealth {
  return { kind: 'unhealthy', incarnation: state.incarnation, verdict };
}

function heartbeatEvidence(incarnation: string, at: number, ready: boolean): HeartbeatEvidence {
  return { incarnation, at, ready };
}

function healthy(state: HealthState, incarnation: string, at: number): HealthyHealth {
  return {
    kind: 'healthy',
    incarnation: state.incarnation,
    lastHeartbeat: heartbeatEvidence(incarnation, at, true),
    deadlineAt: at + POLICY.heartbeatExpiryMs,
  };
}

function reconcileCommand(
  incarnation: string,
  episode: number,
  attempt: number,
  expectedWrapperInstanceId?: string
): Command {
  return {
    kind: 'Reconcile',
    // The episode (absolute deadline) is part of the operation id so a later
    // recovery episode never reuses an earlier episode's command id.
    operationId: operationId('reconcile', incarnation, episode, attempt),
    incarnation,
    attempt,
    deadlineAt: episode,
    ...(expectedWrapperInstanceId !== undefined ? { expectedWrapperInstanceId } : {}),
  };
}

function beginRecovery(
  state: HealthState,
  at: number
): { state: RecoveringHealth; commands: Command[] } {
  const recovering: RecoveringHealth = {
    kind: 'recovering',
    incarnation: state.incarnation,
    step: 'check_sandbox',
    attempts: 0,
    deadlineAt: at + POLICY.recoveryDeadlineMs,
  };
  return {
    state: recovering,
    commands: [reconcileCommand(recovering.incarnation, recovering.deadlineAt, 1)],
  };
}

/** A recovery attempt result is valid only for the episode's in-flight attempt. */
function recoveryFenceMatches(state: RecoveringHealth, fence: RecoveryFence): boolean {
  if (fence.incarnation !== state.incarnation) return false;
  if (fence.episode !== state.deadlineAt) return false;
  const inFlight = state.attempts + 1;
  if (fence.attempt !== inFlight) return false;
  return (
    fence.operationId ===
    reconcileCommand(state.incarnation, state.deadlineAt, inFlight).operationId
  );
}

/**
 * Consume one completed attempt. Exhaustion is derived here, from the recorded
 * attempts, and the absolute deadline is never extended.
 */
function consumeAttempt(state: RecoveringHealth, step?: HealthRecoveryStep): Decision<HealthState> {
  const attempts = state.attempts + 1;
  if (attempts >= POLICY.recoveryMaxAttempts) {
    return { state: unhealthy(state, 'unresponsive'), commands: [], deadlineAt: null };
  }
  const next: RecoveringHealth = { ...state, attempts, ...(step !== undefined ? { step } : {}) };
  return {
    state: next,
    commands: [reconcileCommand(next.incarnation, next.deadlineAt, attempts + 1)],
    deadlineAt: next.deadlineAt,
  };
}

function acceptHeartbeat(
  state: HealthState,
  event: { incarnation: string; at: number; ready: boolean }
): Decision<HealthState> | undefined {
  if (!matches(state, event.incarnation)) return undefined;
  if (event.ready) {
    const next = healthy(state, event.incarnation, event.at);
    return { state: next, commands: [], deadlineAt: next.deadlineAt };
  }
  if (state.kind === 'recovering') {
    // A not-ready heartbeat is not an attempt result, so it neither consumes
    // budget nor re-emits Reconcile while an attempt is in flight.
    return { state, commands: [], deadlineAt: state.deadlineAt };
  }
  const beginning = beginRecovery(state, event.at);
  return {
    state: beginning.state,
    commands: beginning.commands,
    deadlineAt: beginning.state.deadlineAt,
  };
}

function startRecovery(state: HealthState, at: number): Decision<HealthState> {
  const beginning = beginRecovery(state, at);
  return {
    state: beginning.state,
    commands: beginning.commands,
    deadlineAt: beginning.state.deadlineAt,
  };
}

export function decideHealth(
  state: HealthState,
  event: HealthEvent,
  now: number
): Decision<HealthState> | undefined {
  if (state.kind === 'unhealthy') return undefined;

  switch (event.type) {
    case 'CONNECTED':
    case 'HEARTBEAT':
      return acceptHeartbeat(state, event);
    case 'RECOVERY_SUCCEEDED': {
      if (state.kind !== 'recovering' || !event.ready) return undefined;
      if (!recoveryFenceMatches(state, event.fence)) return undefined;
      const next = healthy(state, event.fence.incarnation, event.at);
      return { state: next, commands: [], deadlineAt: next.deadlineAt };
    }
    case 'HEALTH_OBSERVED': {
      if (!matches(state, event.incarnation)) return undefined;
      if (event.providerState === 'terminal') {
        const next = unhealthy(state, 'absent');
        return { state: next, commands: [], deadlineAt: null };
      }
      if (state.kind === 'recovering') {
        return { state, commands: [], deadlineAt: state.deadlineAt };
      }
      const observation = {
        incarnation: event.incarnation,
        at: event.at,
        providerState: event.providerState,
      };
      if (event.providerState === 'active') {
        if (state.kind === 'healthy') {
          const next = { ...state, lastObservation: observation };
          return { state: next, commands: [], deadlineAt: next.deadlineAt };
        }
        return startRecovery(state, event.at);
      }
      // providerState 'unknown'
      if (state.kind === 'healthy') {
        return startRecovery(state, event.at);
      }
      const next = { ...state, lastObservation: observation };
      return { state: next, commands: [], deadlineAt: next.deadlineAt };
    }
    case 'RECOVERY_STEP': {
      if (state.kind !== 'recovering') return undefined;
      if (RECOVERY_STEP_ORDER[event.step] <= RECOVERY_STEP_ORDER[state.step]) return undefined;
      if (!recoveryFenceMatches(state, event.fence)) return undefined;
      return consumeAttempt(state, event.step);
    }
    case 'RECOVERY_ATTEMPT_FAILED': {
      if (state.kind !== 'recovering') return undefined;
      if (!recoveryFenceMatches(state, event.fence)) return undefined;
      return consumeAttempt(state);
    }
    case 'HEALTH_UNHEALTHY': {
      const next = unhealthy(state, event.verdict);
      return { state: next, commands: [], deadlineAt: null };
    }
    case 'CANCEL': {
      if (state.kind === 'healthy') return undefined;
      const next = unhealthy(state, 'unresponsive');
      return { state: next, commands: [], deadlineAt: null };
    }
    case 'DEADLINE': {
      if (state.kind === 'recovering') {
        if (now < state.deadlineAt) {
          return { state, commands: [], deadlineAt: state.deadlineAt };
        }
        const next = unhealthy(state, 'unresponsive');
        return { state: next, commands: [], deadlineAt: null };
      }
      if (now < state.deadlineAt) {
        return { state, commands: [], deadlineAt: state.deadlineAt };
      }
      return startRecovery(state, now);
    }
  }
}
