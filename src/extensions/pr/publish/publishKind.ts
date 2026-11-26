import { Type } from 'typebox';
import type { Static } from 'typebox';

export const publicationKindSchema = Type.Union(
  [Type.Literal('pullRequest'), Type.Literal('comment'), Type.Literal('review')],
  { description: 'dryRun/publish: the write to send.' },
);

export type PublicationKind = Static<typeof publicationKindSchema>;
