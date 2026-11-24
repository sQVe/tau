import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { notifyOnce } from '../../../config/config.js';
import { errorMessage } from '../../../errors.js';
import { readAskRecordAt, updateHiddenAskRecordAt } from '../record.js';
import { askDeadlineAction } from './askDecision.js';

export interface AskDeadline {
  stop: () => Promise<void>;
}

// A refusal from the directory guard can clear, so a failed expiry keeps a timer instead of
// leaving the running ask to end without one.
const deadlineRetryMilliseconds = 5000;

// Returns the deadline to rearm for any unchanged running record, including one already due.
const expireAskRecord = async (
  checkout: string,
  path: string,
  context: ExtensionContext,
): Promise<number | undefined> => {
  const change = await updateHiddenAskRecordAt(checkout, path, (current) => {
    const action = askDeadlineAction({ now: Date.now(), deadline: current.deadline });

    if (action !== 'expire') {
      return undefined;
    }

    return {
      ...current,
      status: 'timeout',
      detail: 'The ask reached its deadline before the architect answered.',
    };
  });

  if (change?.changed === true) {
    context.shutdown();

    return undefined;
  }

  if (change?.record.status !== 'running') {
    return undefined;
  }

  return change.record.deadline;
};

export const startAskDeadline = async (
  checkout: string,
  path: string,
  context: ExtensionContext,
): Promise<AskDeadline | undefined> => {
  const record = await readAskRecordAt(path);

  if (record?.route !== 'hidden') {
    return undefined;
  }

  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const schedule = (deadline: number): void => {
    if (stopped) {
      return;
    }

    const delay = Math.max(0, deadline - Date.now());

    timer = setTimeout(() => {
      running = (async () => {
        const current = await readAskRecordAt(path);

        if (current?.route !== 'hidden') {
          return;
        }

        if (current.status === 'running' && Date.now() < current.deadline) {
          schedule(current.deadline);

          return;
        }

        const rearmAt = await expireAskRecord(checkout, path, context);

        if (rearmAt !== undefined) {
          schedule(rearmAt);
        }
      })().catch((error: unknown) => {
        notifyOnce(context.ui, path, 'ask-deadline', errorMessage(error), 'error');
        schedule(Date.now() + deadlineRetryMilliseconds);
      });
    }, delay);
  };

  schedule(record.deadline);

  return {
    stop: async () => {
      stopped = true;

      if (timer !== undefined) {
        clearTimeout(timer);
      }

      await running;
    },
  };
};
