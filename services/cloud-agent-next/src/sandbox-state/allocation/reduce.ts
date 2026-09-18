/**
 * Allocation reducer (design §5). Pure: no I/O, no clock read, no storage.
 * `decideAllocation(record, event, now)` returns `undefined` when the event is not
 * accepted for the state (an explicit rejection, not a silent no-op).
 *
 * In `allocated` the counter delegates every health event to the health
 * submachine, keeps the health commands, and maps an `unhealthy` verdict to the
 * allocation transition from design §6 (`absent` → `stopped`,
 * `unresponsive` → `stopping{destroying}`).
 */
import type { Command, Decision } from '../commands.js';
import { operationId } from '../commands.js';
import type { StateMeta, TransitionMeta } from '../registry.js';
import { isHealthEvent, type AllocationInputEvent, type ResultFence } from '../events.js';
import type {
  AllocationCreateIntent,
  AllocationRecord,
  AllocationState,
  AllocationTarget,
  AllocatedAllocation,
  StopProof,
  StoppingAllocation,
  StoppingDestroying,
} from '../model/allocation.js';
import { allocatedConnecting, allocationEffect } from '../model/allocation.js';
import type { HealthState } from '../model/health.js';
import { connectingAt, decideHealth } from '../health/reduce.js';
import { POLICY, allocationAlarmAt, idleStopEligible } from '../schedule.js';

export const ALLOCATION = 'allocation';

export const ALLOCATION_STATES: readonly StateMeta[] = [
  { kind: 'stopped', terminal: false, hasDeadline: false, namedExits: ['DEMAND', 'ACQUIRE'] },
  { kind: 'creating', terminal: false, hasDeadline: true, namedExits: [] },
  { kind: 'allocated.connecting', terminal: false, hasDeadline: true, namedExits: [] },
  { kind: 'allocated.healthy', terminal: false, hasDeadline: true, namedExits: [] },
  { kind: 'allocated.recovering', terminal: false, hasDeadline: true, namedExits: [] },
  { kind: 'stopping.destroying', terminal: false, hasDeadline: true, namedExits: [] },
  {
    kind: 'stopping.check_required',
    terminal: false,
    hasDeadline: false,
    namedExits: ['CHECK', 'DEMAND', 'ACQUIRE'],
  },
  { kind: 'unknown', terminal: false, hasDeadline: true, namedExits: [] },
];

export const ALLOCATION_EVENT_TYPES = [
  'DEMAND',
  'ACQUIRE',
  'CREATE_CONFIRMED',
  'CREATE_FAILED',
  'CREATE_UNKNOWN',
  'HEALTH_UNHEALTHY',
  'DESTROY_CONFIRMED',
  'DESTROY_NOT_CONFIRMED',
  'BUDGET_EXHAUSTED',
  'IDLE',
  'CHECK',
  'OBSERVED',
  'CANCEL',
  'CANCEL.RECOVERY',
  'DEADLINE',
  'CONNECTED',
  'HEARTBEAT',
  'HEALTH_OBSERVED',
  'RECOVERY_STEP',
  'RECOVERY_ATTEMPT_FAILED',
  'RECOVERY_SUCCEEDED',
] as const;

const EFFECT_COMMANDS = ['Stop', 'Destroy'] as const;
const LOSS_COMMANDS = ['Stop', 'Destroy', 'NotifySession'] as const;

export const ALLOCATION_TRANSITIONS: readonly TransitionMeta[] = [
  { from: 'stopped', event: 'DEMAND', to: 'creating', commands: ['Create'], deadline: 'create' },
  { from: 'stopped', event: 'ACQUIRE', to: 'creating', commands: ['Create'], deadline: 'create' },

  {
    from: 'creating',
    event: 'CREATE_CONFIRMED',
    to: 'allocated.connecting',
    commands: [],
    deadline: 'connect',
  },
  { from: 'creating', event: 'CREATE_FAILED', to: 'stopped', commands: [], deadline: null },
  {
    from: 'creating',
    event: 'CREATE_UNKNOWN',
    to: 'unknown',
    commands: ['Observe'],
    deadline: 'observe',
  },
  {
    from: 'creating',
    event: 'DEADLINE',
    to: 'unknown',
    commands: ['Observe'],
    deadline: 'observe',
  },
  { from: 'creating', event: 'DEADLINE', to: 'creating', commands: [], deadline: 'create' },

  {
    from: 'allocated.connecting',
    event: 'DEMAND',
    to: 'allocated.connecting',
    commands: [],
    deadline: 'health',
  },
  {
    from: 'allocated.healthy',
    event: 'DEMAND',
    to: 'allocated.healthy',
    commands: [],
    deadline: 'health',
  },
  {
    from: 'allocated.recovering',
    event: 'DEMAND',
    to: 'allocated.recovering',
    commands: [],
    deadline: 'health',
  },
  {
    from: 'allocated.connecting',
    event: 'IDLE',
    to: 'stopping.destroying',
    commands: EFFECT_COMMANDS,
    deadline: 'destroy',
  },
  {
    from: 'allocated.healthy',
    event: 'IDLE',
    to: 'stopping.destroying',
    commands: EFFECT_COMMANDS,
    deadline: 'destroy',
  },
  {
    from: 'allocated.connecting',
    event: 'IDLE',
    to: 'allocated.connecting',
    commands: [],
    deadline: 'health',
  },
  {
    from: 'allocated.healthy',
    event: 'IDLE',
    to: 'allocated.healthy',
    commands: [],
    deadline: 'health',
  },
  {
    from: 'allocated.connecting',
    event: 'CANCEL',
    to: 'stopping.destroying',
    commands: EFFECT_COMMANDS,
    deadline: 'destroy',
  },
  {
    from: 'allocated.healthy',
    event: 'CANCEL',
    to: 'stopping.destroying',
    commands: EFFECT_COMMANDS,
    deadline: 'destroy',
  },
  {
    from: 'allocated.recovering',
    event: 'CANCEL',
    to: 'stopping.destroying',
    commands: EFFECT_COMMANDS,
    deadline: 'destroy',
  },
  {
    from: 'allocated.connecting',
    event: 'DEADLINE',
    to: 'stopping.destroying',
    commands: EFFECT_COMMANDS,
    deadline: 'destroy',
  },
  {
    from: 'allocated.healthy',
    event: 'DEADLINE',
    to: 'stopping.destroying',
    commands: EFFECT_COMMANDS,
    deadline: 'destroy',
  },
  {
    from: 'allocated.connecting',
    event: 'DEADLINE',
    to: 'allocated.connecting',
    commands: [],
    deadline: 'health',
  },
  {
    from: 'allocated.connecting',
    event: 'DEADLINE',
    to: 'allocated.recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  {
    from: 'allocated.healthy',
    event: 'DEADLINE',
    to: 'allocated.healthy',
    commands: [],
    deadline: 'health',
  },
  {
    from: 'allocated.healthy',
    event: 'DEADLINE',
    to: 'allocated.recovering',
    commands: ['Reconcile'],
    deadline: 'recovery',
  },
  {
    from: 'allocated.recovering',
    event: 'DEADLINE',
    to: 'allocated.recovering',
    commands: [],
    deadline: 'recovery',
  },
  {
    from: 'allocated.recovering',
    event: 'DEADLINE',
    to: 'stopping.destroying',
    commands: LOSS_COMMANDS,
    deadline: 'destroy',
  },

  {
    from: 'stopping.destroying',
    event: 'DESTROY_CONFIRMED',
    to: 'stopped',
    commands: ['NotifySession'],
    deadline: null,
  },
  {
    from: 'stopping.destroying',
    event: 'DESTROY_NOT_CONFIRMED',
    to: 'stopping.destroying',
    commands: EFFECT_COMMANDS,
    deadline: 'destroy',
  },
  {
    from: 'stopping.destroying',
    event: 'BUDGET_EXHAUSTED',
    to: 'stopping.check_required',
    commands: [],
    deadline: null,
  },
  {
    from: 'stopping.destroying',
    event: 'DEADLINE',
    to: 'stopping.check_required',
    commands: [],
    deadline: null,
  },
  {
    from: 'stopping.destroying',
    event: 'DEADLINE',
    to: 'stopping.destroying',
    commands: [],
    deadline: 'destroy',
  },
  {
    from: 'stopping.destroying',
    event: 'OBSERVED',
    to: 'stopped',
    commands: ['NotifySession'],
    deadline: null,
  },
  {
    from: 'stopping.destroying',
    event: 'OBSERVED',
    to: 'stopping.destroying',
    commands: EFFECT_COMMANDS,
    deadline: 'destroy',
  },
  {
    from: 'stopping.destroying',
    event: 'CANCEL',
    to: 'stopping.destroying',
    commands: EFFECT_COMMANDS,
    deadline: 'destroy',
  },

  {
    from: 'stopping.check_required',
    event: 'CHECK',
    to: 'stopping.destroying',
    commands: ['Observe'],
    deadline: 'destroy',
  },
  {
    from: 'stopping.check_required',
    event: 'DEMAND',
    to: 'stopping.destroying',
    commands: EFFECT_COMMANDS,
    deadline: 'destroy',
  },
  {
    from: 'stopping.check_required',
    event: 'ACQUIRE',
    to: 'stopping.destroying',
    commands: EFFECT_COMMANDS,
    deadline: 'destroy',
  },

  { from: 'unknown', event: 'OBSERVED', to: 'stopped', commands: [], deadline: null },
  {
    from: 'unknown',
    event: 'OBSERVED',
    to: 'stopping.destroying',
    commands: EFFECT_COMMANDS,
    deadline: 'destroy',
  },
  { from: 'unknown', event: 'DEADLINE', to: 'unknown', commands: ['Observe'], deadline: 'observe' },
];

/** Fields written only by this reducer. */
export const ALLOCATION_OWNED_FIELDS = [
  'state.kind',
  'resumable',
  'state.summary',
  'state.requestId',
  'state.target',
  'state.createIntent',
  'state.attempt',
  'state.attempts',
  'state.deadlineAt',
  'state.idleAt',
  'state.stopIntent',
  'state.step',
  'state.reason',
] as const;

export function allocationStateKey(state: AllocationState): string {
  if (state.kind === 'stopping') return `stopping.${state.step}`;
  if (state.kind === 'allocated') return `allocated.${state.health.kind}`;
  return state.kind;
}

function effectFor(target: AllocationTarget): 'stop' | 'destroy' {
  return allocationEffect(target.capabilities);
}

function fenceMatches(
  fence: ResultFence | undefined,
  expectedOperationId: string,
  providerRef?: string | null,
  incarnation?: string
): boolean {
  if (!fence || fence.operationId !== expectedOperationId) return false;
  if (providerRef !== undefined && fence.providerRef !== providerRef) return false;
  if (incarnation !== undefined && fence.incarnation !== incarnation) return false;
  return true;
}

function effectCommand(target: AllocationTarget, reason: string, opKey: string): Command[] {
  const effect = effectFor(target);
  return effect === 'stop'
    ? [{ kind: 'Stop', operationId: opKey, target, reason }]
    : [{ kind: 'Destroy', operationId: opKey, target, reason }];
}

function effectOperationId(state: StoppingDestroying): string {
  return operationId('stop', state.stopIntent.createdAt, state.attempts);
}

function notifyCommand(reason: string, at: number, proof?: StopProof): Command {
  return {
    kind: 'NotifySession',
    operationId: operationId('notify', at, reason),
    reason,
    ...(proof ? { stopProof: proof } : {}),
  };
}

function lossProof(
  target: AllocationTarget,
  incarnation: string,
  reason: string,
  now: number,
  wrapper?: string
): StopProof {
  return {
    effect: effectFor(target),
    at: now,
    providerRef: target.providerRef,
    ...(target.allocationName !== undefined ? { allocationName: target.allocationName } : {}),
    incarnation,
    ...(wrapper !== undefined ? { wrapper } : {}),
    reason,
  };
}

function enterStopping(
  target: AllocationTarget,
  createIntent: AllocationCreateIntent,
  reason: string,
  now: number,
  incarnation: string,
  wrapperInstanceId?: string
): StoppingDestroying {
  return {
    kind: 'stopping',
    target,
    createIntent,
    stopIntent: {
      reason,
      createdAt: now,
      incarnation,
      ...(wrapperInstanceId ? { wrapperInstanceId } : {}),
    },
    step: 'destroying',
    attempts: 0,
    deadlineAt: now + POLICY.stopDeadlineMs,
  };
}

function stoppedFromLoss(
  target: AllocationTarget,
  incarnation: string,
  reason: string,
  now: number,
  wrapper?: string
): AllocationState {
  return {
    kind: 'stopped',
    summary: {
      providerRef: target.providerRef,
      ...(target.allocationName !== undefined ? { allocationName: target.allocationName } : {}),
      stopProof: lossProof(target, incarnation, reason, now, wrapper),
    },
  };
}

function applyHealth(
  record: AllocationRecord,
  state: AllocatedAllocation,
  health: HealthState,
  commands: Command[],
  now: number
): Decision<AllocationRecord> | undefined {
  const incarnation = state.health.incarnation;
  if (health.kind === 'unhealthy') {
    const reason = `health_unhealthy_${health.verdict}`;
    if (health.verdict === 'absent') {
      const next = stoppedFromLoss(state.target, incarnation, reason, now);
      return {
        state: { v: 2, resumable: record.resumable, state: next },
        commands: [notifyCommand(reason, now, lossProof(state.target, incarnation, reason, now))],
        deadlineAt: null,
      };
    }
    const stopping = enterStopping(state.target, state.createIntent, reason, now, incarnation);
    return {
      state: { v: 2, resumable: record.resumable, state: stopping },
      commands: [
        ...effectCommand(state.target, reason, effectOperationId(stopping)),
        notifyCommand(reason, now, lossProof(state.target, incarnation, reason, now)),
      ],
      deadlineAt: stopping.deadlineAt,
    };
  }
  const allocated: AllocationState = { ...state, health };
  const next: AllocationRecord = { v: 2, resumable: record.resumable, state: allocated };
  return { state: next, commands, deadlineAt: allocationAlarmAt(next) };
}

function delegatedHealth(
  record: AllocationRecord,
  state: AllocatedAllocation,
  event: AllocationInputEvent,
  now: number
): Decision<AllocationRecord> | undefined {
  if (!isHealthEvent(event)) return undefined;
  const decision = decideHealth(state.health, event, now);
  if (decision === undefined) return undefined;
  return applyHealth(record, state, decision.state, decision.commands, now);
}

export function decideAllocation(
  record: AllocationRecord,
  event: AllocationInputEvent,
  now: number
): Decision<AllocationRecord> | undefined {
  const { state } = record;

  switch (state.kind) {
    case 'stopped': {
      if (event.type !== 'DEMAND' && event.type !== 'ACQUIRE') return undefined;
      const target = event.target;
      const deadlineAt = now + POLICY.createDeadlineMs;
      const next: AllocationRecord = {
        v: 2,
        resumable: record.resumable,
        state: {
          kind: 'creating',
          requestId: event.requestId,
          target,
          createIntent: event.createIntent,
          attempt: 1,
          deadlineAt,
        },
      };
      return {
        state: next,
        commands: [
          {
            kind: 'Create',
            operationId: operationId('create', event.createIntent.intentId),
            target,
            intentId: event.createIntent.intentId,
          },
        ],
        deadlineAt,
      };
    }

    case 'creating': {
      const expected = operationId('create', state.createIntent.intentId);
      switch (event.type) {
        case 'CREATE_CONFIRMED': {
          if (!fenceMatches(event.fence, expected, undefined, event.incarnation)) return undefined;
          const target: AllocationTarget = {
            ...state.target,
            providerRef: event.providerRef,
            ...(event.resolvedContainment !== undefined
              ? { resolvedContainment: event.resolvedContainment }
              : {}),
          };
          const health = connectingAt(event.incarnation, now);
          const allocated = allocatedConnecting(target, state.createIntent, health);
          return {
            state: { v: 2, resumable: record.resumable, state: allocated },
            commands: [],
            deadlineAt: health.deadlineAt,
          };
        }
        case 'CREATE_FAILED': {
          if (!fenceMatches(event.fence, expected)) return undefined;
          const next: AllocationRecord = {
            v: 2,
            resumable: record.resumable,
            state: {
              kind: 'stopped',
              summary: {
                providerRef: state.target.providerRef,
                ...(state.target.allocationName !== undefined
                  ? { allocationName: state.target.allocationName }
                  : {}),
              },
            },
          };
          return { state: next, commands: [], deadlineAt: null };
        }
        case 'CREATE_UNKNOWN':
          if (!fenceMatches(event.fence, expected)) return undefined;
          return toUnknown(record, state.target, state.createIntent, event.reason, now);
        case 'DEADLINE':
          if (now < state.deadlineAt) {
            return { state: record, commands: [], deadlineAt: state.deadlineAt };
          }
          return toUnknown(record, state.target, state.createIntent, 'create_deadline', now);
        default:
          return undefined;
      }
    }

    case 'allocated': {
      switch (event.type) {
        case 'DEMAND': {
          // Fresh demand pins the allocation: clear the idle anchor.
          const next: AllocationRecord = {
            v: 2,
            resumable: record.resumable,
            state: { ...state, idleAt: null },
          };
          return { state: next, commands: [], deadlineAt: allocationAlarmAt(next) };
        }
        case 'IDLE': {
          if (!idleStopEligible(state.health)) return undefined;
          if (now < event.idleAt) {
            const next: AllocationRecord = {
              v: 2,
              resumable: record.resumable,
              state: { ...state, idleAt: event.idleAt },
            };
            return { state: next, commands: [], deadlineAt: allocationAlarmAt(next) };
          }
          return enterStoppingFromAllocated(record, state, 'idle', now);
        }
        case 'CANCEL': {
          if (event.scope === 'recovery') {
            return delegatedHealth(record, state, event, now);
          }
          return enterStoppingFromAllocated(
            record,
            state,
            event.reason ?? 'cancel_allocation',
            now
          );
        }
        case 'DEADLINE': {
          if (idleStopEligible(state.health) && state.idleAt !== null && now >= state.idleAt) {
            return enterStoppingFromAllocated(record, state, 'idle', now);
          }
          const decision = decideHealth(state.health, event, now);
          if (decision === undefined) return undefined;
          return applyHealth(record, state, decision.state, decision.commands, now);
        }
        default:
          return delegatedHealth(record, state, event, now);
      }
    }

    case 'stopping': {
      if (state.step === 'check_required') {
        if (event.type !== 'CHECK' && event.type !== 'DEMAND' && event.type !== 'ACQUIRE') {
          return undefined;
        }
        const deadlineAt = now + POLICY.stopDeadlineMs;
        const next: StoppingDestroying = {
          ...state,
          step: 'destroying',
          attempts: 0,
          deadlineAt,
        };
        if (event.type === 'CHECK') {
          return {
            state: { v: 2, resumable: record.resumable, state: next },
            commands: [
              {
                kind: 'Observe',
                operationId: operationId('observe', state.stopIntent.createdAt),
                target: state.target,
              },
            ],
            deadlineAt,
          };
        }
        return {
          state: { v: 2, resumable: record.resumable, state: next },
          commands: effectCommand(state.target, state.stopIntent.reason, effectOperationId(next)),
          deadlineAt,
        };
      }

      const expected = effectOperationId(state);
      switch (event.type) {
        case 'DESTROY_CONFIRMED': {
          if (
            !fenceMatches(
              event.fence,
              expected,
              state.target.providerRef,
              state.stopIntent.incarnation
            )
          ) {
            return undefined;
          }
          const proof = event.proof;
          if (proof.effect !== allocationEffect(state.target.capabilities)) return undefined;
          if (
            state.stopIntent.incarnation !== undefined &&
            proof.incarnation !== state.stopIntent.incarnation
          ) {
            return undefined;
          }
          if (
            state.stopIntent.wrapperInstanceId !== undefined &&
            proof.wrapper !== undefined &&
            proof.wrapper !== state.stopIntent.wrapperInstanceId
          ) {
            return undefined;
          }
          const next: AllocationRecord = {
            v: 2,
            resumable: record.resumable,
            state: {
              kind: 'stopped',
              summary: {
                providerRef: state.target.providerRef,
                ...(state.target.allocationName !== undefined
                  ? { allocationName: state.target.allocationName }
                  : {}),
                stopProof: proof,
              },
            },
          };
          return {
            state: next,
            commands: [notifyCommand(state.stopIntent.reason, now, proof)],
            deadlineAt: null,
          };
        }
        case 'DESTROY_NOT_CONFIRMED': {
          if (
            !fenceMatches(
              event.fence,
              expected,
              state.target.providerRef,
              state.stopIntent.incarnation
            )
          ) {
            return undefined;
          }
          if (state.attempts + 1 >= POLICY.stopMaxAttempts) {
            return toCheckRequired(record, state);
          }
          const attempts = state.attempts + 1;
          const next: StoppingDestroying = {
            ...state,
            attempts,
          };
          return {
            state: { v: 2, resumable: record.resumable, state: next },
            commands: effectCommand(
              state.target,
              state.stopIntent.reason,
              operationId('stop', state.stopIntent.createdAt, attempts)
            ),
            deadlineAt: state.deadlineAt,
          };
        }
        case 'OBSERVED': {
          // Arrives after `stopping.check_required` + CHECK emitted Observe.
          const observeExpected = operationId('observe', state.stopIntent.createdAt);
          if (
            !fenceMatches(
              event.fence,
              observeExpected,
              state.target.providerRef,
              state.stopIntent.incarnation
            )
          ) {
            return undefined;
          }
          if (event.result === 'absent') {
            const proof = lossProof(
              state.target,
              state.stopIntent.incarnation ?? state.target.providerRef ?? 'unknown',
              state.stopIntent.reason,
              now,
              state.stopIntent.wrapperInstanceId
            );
            return {
              state: {
                v: 2,
                resumable: record.resumable,
                state: {
                  kind: 'stopped',
                  summary: {
                    providerRef: state.target.providerRef,
                    ...(state.target.allocationName !== undefined
                      ? { allocationName: state.target.allocationName }
                      : {}),
                    stopProof: proof,
                  },
                },
              },
              commands: [notifyCommand(state.stopIntent.reason, now, proof)],
              deadlineAt: null,
            };
          }
          return {
            state: record,
            commands: effectCommand(state.target, state.stopIntent.reason, expected),
            deadlineAt: state.deadlineAt,
          };
        }
        case 'BUDGET_EXHAUSTED':
          return toCheckRequired(record, state);
        case 'DEADLINE':
          if (now < state.deadlineAt) {
            return { state: record, commands: [], deadlineAt: state.deadlineAt };
          }
          return toCheckRequired(record, state);
        case 'CANCEL': {
          if (event.scope !== 'allocation') return undefined;
          return {
            state: record,
            commands: effectCommand(state.target, state.stopIntent.reason, expected),
            deadlineAt: state.deadlineAt,
          };
        }
        default:
          return undefined;
      }
    }

    case 'unknown': {
      switch (event.type) {
        case 'OBSERVED': {
          const target = state.target;
          const expected = operationId(
            'observe',
            target?.providerRef ?? state.createIntent?.intentId ?? 'unknown'
          );
          if (!fenceMatches(event.fence, expected, target?.providerRef)) return undefined;
          if (event.result === 'absent') {
            const next: AllocationRecord = {
              v: 2,
              resumable: record.resumable,
              state: {
                kind: 'stopped',
                summary: target
                  ? {
                      providerRef: target.providerRef,
                      ...(target.allocationName !== undefined
                        ? { allocationName: target.allocationName }
                        : {}),
                    }
                  : null,
              },
            };
            return { state: next, commands: [], deadlineAt: null };
          }
          if (!target || !state.createIntent) return undefined;
          const incarnation = state.createIntent.intentId;
          const stopping = enterStopping(
            target,
            state.createIntent,
            'observed_present',
            now,
            incarnation
          );
          return {
            state: { v: 2, resumable: record.resumable, state: stopping },
            commands: effectCommand(
              target,
              stopping.stopIntent.reason,
              effectOperationId(stopping)
            ),
            deadlineAt: stopping.deadlineAt,
          };
        }
        case 'DEADLINE': {
          if (!state.target) return undefined;
          const deadlineAt = now + POLICY.observeDeadlineMs;
          const next: AllocationRecord = {
            v: 2,
            resumable: record.resumable,
            state: { ...state, deadlineAt },
          };
          return {
            state: next,
            commands: [
              {
                kind: 'Observe',
                operationId: operationId(
                  'observe',
                  state.target.providerRef ?? state.createIntent?.intentId ?? state.reason
                ),
                target: state.target,
              },
            ],
            deadlineAt,
          };
        }
        default:
          return undefined;
      }
    }
  }
}

function toUnknown(
  record: AllocationRecord,
  target: AllocationTarget | null,
  createIntent: AllocationCreateIntent | null,
  reason: string,
  now: number
): Decision<AllocationRecord> {
  const deadlineAt = now + POLICY.observeDeadlineMs;
  const next: AllocationRecord = {
    v: 2,
    resumable: record.resumable,
    state: {
      kind: 'unknown',
      target,
      createIntent,
      stopIntent: null,
      attempts: 0,
      reason,
      deadlineAt,
    },
  };
  const commands: Command[] =
    target === null
      ? []
      : [
          {
            kind: 'Observe',
            operationId: operationId(
              'observe',
              target.providerRef ?? createIntent?.intentId ?? 'unknown'
            ),
            target,
          },
        ];
  return { state: next, commands, deadlineAt };
}

function enterStoppingFromAllocated(
  record: AllocationRecord,
  state: AllocatedAllocation,
  reason: string,
  now: number
): Decision<AllocationRecord> {
  const stopping = enterStopping(
    state.target,
    state.createIntent,
    reason,
    now,
    state.health.incarnation
  );
  return {
    state: { v: 2, resumable: record.resumable, state: stopping },
    commands: effectCommand(state.target, reason, effectOperationId(stopping)),
    deadlineAt: stopping.deadlineAt,
  };
}

function toCheckRequired(
  record: AllocationRecord,
  state: StoppingDestroying
): Decision<AllocationRecord> {
  const next: StoppingAllocation = {
    kind: 'stopping',
    target: state.target,
    createIntent: state.createIntent,
    stopIntent: state.stopIntent,
    step: 'check_required',
    attempts: state.attempts,
  };
  return {
    state: { v: 2, resumable: record.resumable, state: next },
    commands: [],
    deadlineAt: null,
  };
}
