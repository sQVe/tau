import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from 'typebox';
import type { Static, TProperties } from 'typebox';
import { Value } from 'typebox/value';

import { hasErrorCode, isMissingFile } from '../errors.ts';
import { parseVersionedRecord, publishTextSync } from '../record.ts';
import { describeSchemaProblem, isRecord, stringEnum } from '../schema.ts';
import { ensureTauDirectory, rejectLinkedFile } from '../tauDirectory.ts';

export type ImprovementEvent = Static<typeof eventSchema>;

export type EventKind = ImprovementEvent['kind'];

export type WriteOutcome = 'saved' | 'existing';

const eventVersion = 1;

const eventDirectoryPath = 'improvement';

const eventFileMode = 0o600;

const safeEventIdPattern = '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$';

const eventId = Type.String({ pattern: safeEventIdPattern });

const isoTime = Type.String({
  pattern: String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`,
});

const text = Type.String({ minLength: 1 });

const pullRequestUrl = Type.String({ pattern: '^https://' });

const evidenceSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('transcript'),
      path: text,
      toolCallId: text,
      entryId: Type.Optional(text),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('session'), sessionId: text, toolCallId: text },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('assignment'), directory: text },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('pullRequest'), url: pullRequestUrl },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('reviewCapture'), ref: text }, { additionalProperties: false }),
]);

const eventOf = <Kind extends string, Fields extends TProperties>(kind: Kind, fields: Fields) =>
  Type.Object(
    {
      version: Type.Literal(eventVersion),
      id: eventId,
      kind: Type.Literal(kind),
      createdAt: isoTime,
      supersedes: Type.Optional(eventId),
      evidence: Type.Array(evidenceSchema),
      ...fields,
    },
    { additionalProperties: false },
  );

const kindSchemas = {
  merge: eventOf('merge', { repository: text, pullRequest: pullRequestUrl, mergedAt: isoTime }),
  facts: eventOf('facts', {
    pullRequest: pullRequestUrl,
    facts: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
    coverage: stringEnum(['complete', 'managerOnly', 'missing']),
  }),
  correction: eventOf('correction', { summary: text, cwd: text }),
  review: eventOf('review', { pullRequest: pullRequestUrl, outcome: text }),
  decision: eventOf('decision', {
    subject: eventId,
    choice: stringEnum(['approved', 'rejected', 'redirected']),
  }),
  backlog: eventOf('backlog', { summary: text, pullRequest: pullRequestUrl }),
};

const eventSchema = Type.Union([
  kindSchemas.merge,
  kindSchemas.facts,
  kindSchemas.correction,
  kindSchemas.review,
  kindSchemas.decision,
  kindSchemas.backlog,
]);

const isEventKind = (kind: unknown): kind is EventKind =>
  typeof kind === 'string' && Object.hasOwn(kindSchemas, kind);

// The union schema reports a problem against its first member, so a known kind is checked against
// its own schema to name the field that is wrong.
const checkKindFields = (value: unknown): string | undefined => {
  const kind = isRecord(value) ? value['kind'] : undefined;

  if (!isEventKind(kind)) {
    return undefined;
  }

  const schema = kindSchemas[kind];

  return Value.Check(schema, value) ? undefined : describeSchemaProblem(schema, value);
};

const eventOptions = {
  label: 'improvement event',
  version: eventVersion,
  schema: eventSchema,
  check: checkKindFields,
};

const isSafeEventId = (id: string) => new RegExp(safeEventIdPattern, 'u').test(id);

const isUnpublished = (name: string) => name.startsWith('.receipt-');

const eventDirectory = (projectRoot: string) => join(projectRoot, '.tau', eventDirectoryPath);

export const eventPath = (projectRoot: string, id: string): string =>
  join(eventDirectory(projectRoot), `${id}.json`);

export const parseEvent = (path: string, eventText: string): ImprovementEvent =>
  parseVersionedRecord(path, eventText, eventOptions);

// Saves the event as `<project root>/.tau/improvement/<id>.json`. An event is never replaced, so a
// second write of the same ID keeps the first file and returns `existing`.
export const writeEvent = async (
  projectRoot: string,
  event: ImprovementEvent,
): Promise<WriteOutcome> => {
  if (!isSafeEventId(event.id)) {
    throw new Error(`Improvement event ID ${JSON.stringify(event.id)} is not a safe file name.`);
  }

  const directory = await ensureTauDirectory(projectRoot, eventDirectoryPath);
  const eventText = `${JSON.stringify(event, null, 2)}\n`;

  try {
    publishTextSync(join(directory, `${event.id}.json`), eventText, { mode: eventFileMode });
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return 'existing';
    }

    throw error;
  }

  return 'saved';
};

const listEventNames = async (directory: string): Promise<string[]> => {
  try {
    const names = await readdir(directory);

    return names.filter((name) => !isUnpublished(name)).toSorted();
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
};

// Lists the events in file name order. The first damaged event file stops the read with an error
// naming it, so no reader acts on a partial list.
export const readEvents = async (projectRoot: string): Promise<ImprovementEvent[]> => {
  const directory = eventDirectory(projectRoot);
  const names = await listEventNames(directory);
  const events: ImprovementEvent[] = [];

  for (const name of names) {
    const path = join(directory, name);

    // oxlint-disable-next-line no-await-in-loop -- Reading in name order names the first damaged file.
    await rejectLinkedFile(path, 'read');
    // oxlint-disable-next-line no-await-in-loop -- Reading in name order names the first damaged file.
    events.push(parseEvent(path, await readFile(path, 'utf8')));
  }

  return events;
};
