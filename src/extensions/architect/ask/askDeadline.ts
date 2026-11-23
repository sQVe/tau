import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { notifyOnce } from '../../../config/config.js';
import { errorMessage } from '../../../errors.js';
import { readAskRecordAt, updateHiddenAskRecordAt } from '../record.js';
import { askDeadlineAction } from './askDecision.js';

export interface AskDeadline {
  stop: () => Promise<void>;
}

// Returns the deadline to rearm when a clock rollback leaves the locked record running before
// its deadline.
const expireAskRecord = async (
  path: string,
  context: ExtensionContext,
): Promise<number | undefined> => {
  const change = await updateHiddenAskRecordAt(path, (current) => {
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

  if (change === undefined || Date.now() >= change.record.deadline) {
    return undefined;
  }

  return change.record.deadline;
};

export const startAskDeadline = async (
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

        const rearmAt = await expireAskRecord(path, context);

        if (rearmAt !== undefined) {
          schedule(rearmAt);
        }
      })().catch((error: unknown) => {
        notifyOnce(context.ui, path, 'ask-deadline', errorMessage(error), 'error');
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
