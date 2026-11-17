import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from 'typebox';
import type { Static, TProperties, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { errorMessage, hasErrorCode, isMissingFile } from '../errors.ts';
import { newerFormatNotice, parseVersionedRecord, publishTextSync } from '../record.ts';
import { describeSchemaProblem, isRecord, stringEnum } from '../schema.ts';
import { ensureTauDirectory, rejectLinkedFile } from '../tauDirectory.ts';
import { assertWriteWithinTestRoot } from './writeGuard.ts';

export type ImprovementEvent = Static<typeof eventSchemaV2>;

export type WriteOutcome = 'saved' | 'existing';

export interface WrittenEvent {
  path: string;
  outcome: WriteOutcome;
}

export interface EventGap {
  path: string;
  reason: string;
}

// A newer-format or unreadable event is skipped, not refused, so callers must show `gaps` to the user.
export interface EventRead {
  events: ImprovementEvent[];
  gaps: EventGap[];
}

const eventVersion = 2;

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

const eventOf = <Version extends number, Kind extends string, Fields extends TProperties>(
  version: Version,
  kind: Kind,
  fields: Fields,
) =>
  Type.Object(
    {
      version: Type.Literal(version),
      id: eventId,
      kind: Type.Literal(kind),
      createdAt: isoTime,
      supersedes: Type.Optional(eventId),
      evidence: Type.Array(evidenceSchema),
      ...fields,
    },
    { additionalProperties: false },
  );

const mergeFields = { repository: text, pullRequest: pullRequestUrl, mergedAt: isoTime };

const factsFields = {
  pullRequest: pullRequestUrl,
  facts: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
  coverage: stringEnum(['complete', 'managerOnly', 'missing']),
};

const correctionFields = { summary: text, cwd: text };

const reviewFields = { pullRequest: pullRequestUrl, outcome: text };

const decisionFields = {
  subject: eventId,
  choice: stringEnum(['approved', 'rejected', 'redirected']),
};

const backlogFields = { summary: text, pullRequest: pullRequestUrl };

const eventKindsOf = <Version extends number>(version: Version) => ({
  merge: eventOf(version, 'merge', mergeFields),
  facts: eventOf(version, 'facts', factsFields),
  correction: eventOf(version, 'correction', correctionFields),
  review: eventOf(version, 'review', reviewFields),
  decision: eventOf(version, 'decision', decisionFields),
  backlog: eventOf(version, 'backlog', backlogFields),
});

const kindSchemasV1 = eventKindsOf(1);

const kindSchemasV2 = {
  ...eventKindsOf(2),
  pass: eventOf(2, 'pass', { pass: stringEnum(['correct']) }),
  class: eventOf(2, 'class', {
    identity: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,99}$' }),
    level: stringEnum(['architecture', 'type', 'lint', 'test', 'prose']),
    summary: text,
    occurrences: Type.Array(text, { minItems: 1 }),
  }),
};

const eventSchemaV1 = Type.Union([
  kindSchemasV1.merge,
  kindSchemasV1.facts,
  kindSchemasV1.correction,
  kindSchemasV1.review,
  kindSchemasV1.decision,
  kindSchemasV1.backlog,
]);

const eventSchemaV2 = Type.Union([
  kindSchemasV2.merge,
  kindSchemasV2.facts,
  kindSchemasV2.correction,
  kindSchemasV2.review,
  kindSchemasV2.decision,
  kindSchemasV2.backlog,
  kindSchemasV2.pass,
  kindSchemasV2.class,
]);

const kindSchemasByVersion: Readonly<Record<number, Readonly<Record<string, TSchema>>>> = {
  1: kindSchemasV1,
  2: kindSchemasV2,
};

const isEventKind = (schemas: Readonly<Record<string, TSchema>>, kind: unknown): kind is string =>
  typeof kind === 'string' && Object.hasOwn(schemas, kind);

const checkKindFields = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const version = value['version'];
  const schemas = typeof version === 'number' ? kindSchemasByVersion[version] : undefined;
  const kind = value['kind'];

  if (schemas === undefined || !isEventKind(schemas, kind)) {
    return undefined;
  }

  const schema = schemas[kind];

  if (schema === undefined) {
    return undefined;
  }

  return Value.Check(schema, value) ? undefined : describeSchemaProblem(schema, value);
};

const schemaForVersion = (value: unknown) =>
  isRecord(value) && value['version'] === 1 ? eventSchemaV1 : eventSchemaV2;

const eventOptions = {
  label: 'improvement event',
  version: eventVersion,
  schema: schemaForVersion,
  check: checkKindFields,
};

const isSafeEventId = (id: string) => new RegExp(safeEventIdPattern, 'u').test(id);

const isUnpublished = (name: string) => name.startsWith('.receipt-');

export const eventDirectory = (projectRoot: string): string =>
  join(projectRoot, '.tau', eventDirectoryPath);

export const parseEvent = (path: string, eventText: string): ImprovementEvent => {
  const event = parseVersionedRecord(path, eventText, eventOptions);

  return event.version === 1 ? { ...event, version: eventVersion } : event;
};

export const writeEvent = async (
  projectRoot: string,
  event: ImprovementEvent,
): Promise<WrittenEvent> => {
  if (!isSafeEventId(event.id)) {
    throw new Error(`Improvement event ID ${JSON.stringify(event.id)} is not a safe file name.`);
  }

  const directory = eventDirectory(projectRoot);
  const path = join(directory, `${event.id}.json`);

  assertWriteWithinTestRoot(path);
  await ensureTauDirectory(projectRoot, eventDirectoryPath);
  const eventText = `${JSON.stringify(event, null, 2)}\n`;

  try {
    publishTextSync(path, eventText, { mode: eventFileMode });
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return { path, outcome: 'existing' };
    }

    throw error;
  }

  return { path, outcome: 'saved' };
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

export const readEvents = async (projectRoot: string): Promise<EventRead> => {
  const directory = eventDirectory(projectRoot);
  const names = await listEventNames(directory);
  const events: ImprovementEvent[] = [];
  const gaps: EventGap[] = [];

  for (const name of names) {
    const path = join(directory, name);

    try {
      // oxlint-disable-next-line no-await-in-loop -- Reading in name order keeps gap order stable.
      await rejectLinkedFile(path, 'read');
      // oxlint-disable-next-line no-await-in-loop -- Reading in name order keeps gap order stable.
      const eventText = await readFile(path, 'utf8');
      const notice = newerFormatNotice(path, eventText, eventOptions);

      if (notice !== undefined) {
        gaps.push({ path, reason: notice });
      } else {
        events.push(parseEvent(path, eventText));
      }
    } catch (error) {
      gaps.push({ path, reason: errorMessage(error) });
    }
  }

  return { events, gaps };
};
