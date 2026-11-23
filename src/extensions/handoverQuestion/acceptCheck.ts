import type { AcceptCheck } from '../../inbox/inbox.js';
import { currentRole } from '../../role/role.js';

export const handoverQuestionCheck: AcceptCheck = async (request, save) => {
  if (request.family !== 'handover-question') {
    return `This check accepts handover questions, not ${request.family} messages.`;
  }

  const role = currentRole();

  if (role !== 'lead') {
    return `Only a lead session accepts a handover question, not a ${role} session.`;
  }

  return save();
};
