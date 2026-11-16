import type { RunRecord } from '../../verification/records.js';
import { writeRunRecord } from '../../verification/verification.js';
import { decideRegister } from './runDecision.js';
import { readRunRecordOrThrow, runDirectory } from './runFacts.js';

type RegisteredItem = RunRecord['items'][number];

export interface RunContext {
  root: string;
  deadlineMilliseconds: number;
  signal: AbortSignal | undefined;
  run: string;
}

export interface RegisterResult {
  run: string;
  directory: string;
  items: RunRecord['items'];
}

export const registerItems = async (
  context: RunContext,
  items: readonly RegisteredItem[],
): Promise<RegisterResult> => {
  const directory = runDirectory(context.root, context.run);
  const record = await readRunRecordOrThrow(directory, context.run);
  const decision = decideRegister(record, items);

  if (decision.kind === 'refuse') {
    throw new Error(decision.reason);
  }

  const updated: RunRecord = { ...record, items: decision.items };

  await writeRunRecord(directory, updated);

  return { run: record.run, directory, items: updated.items };
};
