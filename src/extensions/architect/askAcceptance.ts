import type { AcceptCheck } from '../../inbox/inbox.js';

export const acceptArchitectAsk =
  (heldToken: () => string | undefined): AcceptCheck =>
  async (request, save) => {
    if (request.family !== 'architect-ask') {
      return `This session does not accept ${request.family} messages.`;
    }

    const { lockToken } = request.payload;

    if (heldToken() !== lockToken) {
      return `This architect does not hold lock ${lockToken} now. It restarted or closed. Call architect ask again.`;
    }

    return save();
  };
