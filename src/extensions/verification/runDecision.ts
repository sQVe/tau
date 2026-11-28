import type { RunRecord } from '../../verification/records.js';

type RegisteredItem = RunRecord['items'][number];

export type RegisterDecision =
  | { kind: 'accept'; items: RegisteredItem[] }
  | { kind: 'refuse'; reason: string };

export type StopDecision =
  | { kind: 'accept' }
  | { kind: 'refuse'; reason: 'The run is already stopped.' };

const stoppedReason = 'The run is stopped. Launch a new run to register items.';

const doctorFailedReason =
  "The run's doctor did not pass, so no item can be driven on it. Stop the run.";

const duplicateRequestItem = (items: readonly RegisteredItem[]): RegisteredItem | undefined => {
  const seen = new Set<string>();

  for (const item of items) {
    const folded = item.item.toLowerCase();

    if (seen.has(folded)) {
      return item;
    }

    seen.add(folded);
  }

  return undefined;
};

const registeredConflict = (
  items: readonly RegisteredItem[],
  registered: readonly RegisteredItem[],
): RegisteredItem | undefined => {
  const names = new Set(registered.map((item) => item.item.toLowerCase()));

  return items.find((item) => names.has(item.item.toLowerCase()));
};

export const decideRegister = (
  run: Pick<RunRecord, 'doctor' | 'stop' | 'items'>,
  items: readonly RegisteredItem[],
): RegisterDecision => {
  if (run.stop !== null) {
    return { kind: 'refuse', reason: stoppedReason };
  }

  if (run.doctor?.exitCode !== 0) {
    return { kind: 'refuse', reason: doctorFailedReason };
  }

  if (items.length === 0) {
    return { kind: 'refuse', reason: 'Register at least one item.' };
  }

  const duplicate = duplicateRequestItem(items);

  if (duplicate !== undefined) {
    return { kind: 'refuse', reason: `${duplicate.item} appears twice in the request.` };
  }

  const conflict = registeredConflict(items, run.items);

  if (conflict !== undefined) {
    return { kind: 'refuse', reason: `${conflict.item} is already registered on this run.` };
  }

  return { kind: 'accept', items: [...run.items, ...items] };
};

export const decideStop = (run: Pick<RunRecord, 'stop'>): StopDecision => {
  if (run.stop?.exitCode !== 0) {
    return { kind: 'accept' };
  }

  return { kind: 'refuse', reason: 'The run is already stopped.' };
};
