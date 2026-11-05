import type { Assignment } from './assignment.js';

export const ownerRefusal = (
  assignment: Pick<Assignment, 'assignmentId' | 'parentSession'>,
  parentSession: string,
): string | undefined =>
  assignment.parentSession === parentSession
    ? undefined
    : `Assignment ${assignment.assignmentId} belongs to another manager session.`;
