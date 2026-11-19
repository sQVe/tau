import type { AcceptCheck } from '../../../inbox/inbox.js';
import { settleWithinCloseLimit } from '../closeLimit.js';

export interface AskAdmissions {
  check: AcceptCheck;
  // Waits for the saves that passed the check, up to the close limit.
  settle: () => Promise<void>;
}

const lockRefusal = (lockToken: string): string =>
  `This architect does not hold lock ${lockToken} now. It restarted or closed. Call architect ask again.`;

export const createAskAdmissions = (heldToken: () => string | undefined): AskAdmissions => {
  const saving = new Set<Promise<unknown>>();

  const check: AcceptCheck = async (request, save) => {
    if (request.family !== 'architect-ask') {
      return `This session does not accept ${request.family} messages.`;
    }

    const { lockToken } = request.payload;

    if (heldToken() !== lockToken) {
      return lockRefusal(lockToken);
    }

    const admitted = save(() => (heldToken() === lockToken ? undefined : lockRefusal(lockToken)));

    saving.add(admitted);

    try {
      return await admitted;
    } finally {
      saving.delete(admitted);
    }
  };

  return { check, settle: () => settleWithinCloseLimit(saving) };
};
