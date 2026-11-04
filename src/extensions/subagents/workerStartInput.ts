import type { InputEventResult } from '@earendil-works/pi-coding-agent';

import { isStartInput, startInputResult } from './workerStart.js';

export interface WorkerStartInput {
  pending: boolean;
  startText: string | undefined;
}

export const handleStartInput = async (
  input: WorkerStartInput,
  text: string,
  ready: Promise<void> | undefined,
): Promise<InputEventResult> => {
  if (!isStartInput(input.pending, text)) {
    return { action: 'continue' };
  }

  input.pending = false;

  await ready;

  return startInputResult(input.startText);
};
