import type { FlatAllocationState } from '../sandbox-control/allocation-view.js';
import type { ConnectionState } from '../sandbox-control/status-projection.js';
import type { PreparingStep } from '../shared/protocol.js';

export type PreparingHint = { step: PreparingStep; message: string };

export function provisionPreparingStep(
  physical: FlatAllocationState,
  allowCreate: boolean
): PreparingHint | null {
  if (physical === 'stopped' && allowCreate) {
    return { step: 'sandbox_provision', message: 'Creating sandbox…' };
  }
  return null;
}

export function bootPreparingStep(
  physical: FlatAllocationState,
  connection: ConnectionState
): PreparingHint | null {
  if (physical === 'creating' || (physical === 'running' && connection !== 'ready')) {
    return { step: 'sandbox_boot', message: 'Starting environment…' };
  }
  return null;
}
