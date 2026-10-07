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

export const fixupSubjectSearchWord = (subject: string): string => {
  const words = subject.match(/\S+/g) ?? [];

  return words.reduce((longest, word) => (word.length > longest.length ? word : longest), '');
};

// Git strips these prefixes when it looks for the target, so such a subject never names itself.
const hasAutosquashPrefix = (subject: string): boolean => /^(?:fixup|squash|amend)! /.test(subject);

export const selectFixupTargetReference = (
  subject: string,
  commitHash: string,
  candidates: { commitHash: string; subject: string }[],
): string => {
  const trimmedSubject = subject.trim();

  if (trimmedSubject === '' || trimmedSubject !== subject || hasAutosquashPrefix(subject)) {
    return commitHash;
  }

  const duplicate = candidates.some(
    (candidate) =>
      candidate.commitHash !== commitHash && candidate.subject.trim() === trimmedSubject,
  );

  return duplicate ? commitHash : subject;
};

export const buildFixupSubject = (
  kind: NonNullable<CommitInput['groups'][number]['fixup']>['kind'],
  targetSubject: string,
): string => `${kind}! ${targetSubject}`;
