import { createHash } from 'node:crypto';

const classHashLength = 16;

export const classEventId = (identity: string, occurrences: readonly string[]): string => {
  const unique = [...new Set(occurrences)].toSorted();
  const hash = createHash('sha256').update(JSON.stringify(unique)).digest('hex');

  return `class-${identity}-${hash.slice(0, classHashLength)}`;
};
