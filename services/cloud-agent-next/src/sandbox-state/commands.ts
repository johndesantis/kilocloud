/**
 * Commands are data. The reducer emits them; a thin runner executes them and feeds
 * the result back as an event. Every command carries an `operationId` so a retried
 * effect is idempotent.
 */
import type { AllocationTarget, StopProof } from './model/allocation.js';

export type OperationId = string;

export type CommandKind =
  | 'Create'
  | 'Stop'
  | 'Destroy'
  | 'Observe'
  | 'Reconcile'
  | 'NotifySession'
  | 'Acquire';

export type CreateCommand = {
  kind: 'Create';
  operationId: OperationId;
  target: AllocationTarget;
  intentId: string;
};

export type StopCommand = {
  kind: 'Stop';
  operationId: OperationId;
  target: AllocationTarget;
  reason: string;
};

export type DestroyCommand = {
  kind: 'Destroy';
  operationId: OperationId;
  target: AllocationTarget;
  reason: string;
};

export type ObserveCommand = {
  kind: 'Observe';
  operationId: OperationId;
  target: AllocationTarget;
};

/**
 * Health-owned recovery operation. The reducer emits it when recovery is entered
 * or advances; the runner executes one attempt and feeds the result back.
 */
export type ReconcileCommand = {
  kind: 'Reconcile';
  operationId: OperationId;
  incarnation: string;
  attempt: number;
  /** Absolute recovery deadline shared by all attempts; never extended. */
  deadlineAt: number;
  expectedWrapperInstanceId?: string;
};

export type NotifySessionCommand = {
  kind: 'NotifySession';
  operationId: OperationId;
  reason: string;
  stopProof?: StopProof;
};

export type AcquireCommand = {
  kind: 'Acquire';
  operationId: OperationId;
  requestId: string;
  deliveryDeadlineAt: number;
};

export type Command =
  | CreateCommand
  | StopCommand
  | DestroyCommand
  | ObserveCommand
  | ReconcileCommand
  | NotifySessionCommand
  | AcquireCommand;

export type CommandResult =
  | { operationId: OperationId; ok: true }
  | { operationId: OperationId; ok: false; reason: string; retryable?: boolean };

export interface CommandRunner {
  run(command: Command): Promise<CommandResult>;
}

export type Decision<T> = {
  state: T;
  commands: Command[];
  deadlineAt: number | null;
};

/** Stable, pure operation id derived from the transition identity. */
export function operationId(...parts: ReadonlyArray<string | number>): OperationId {
  return parts.join(':');
}
