import type { CommitInput } from './validation.js';

export const validateGroupMessage = (group: CommitInput['groups'][number]): void => {
  if (group.subject !== undefined && group.fixup !== undefined) {
    throw new Error('Cannot set both subject and fixup.');
  }

  if (group.subject === undefined && group.fixup === undefined) {
    throw new Error('A subject or fixup is required.');
  }

  const hasReplacement = (group.body?.trim().length ?? 0) > 0;

  if (group.fixup?.kind === 'amend' && !hasReplacement) {
    throw new Error('An amend requires a non-empty body containing the replacement message.');
  }
};

export const buildFixupSubject = (
  kind: NonNullable<CommitInput['groups'][number]['fixup']>['kind'],
  targetSubject: string,
): string => `${kind}! ${targetSubject}`;
