import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';

import { errorMessage, isMissingFile } from '../../errors.js';
import { withFileLock } from '../../fileLock/fileLock.js';
import { isUuid } from '../../inbox/inbox.js';
import { readVersionedRecord, writeRecord } from '../../record.js';
import { isRecord } from '../../schema.js';
import { ensureTauDirectory } from '../../tauDirectory.js';

export type AskRecord = HiddenAskRecord | LiveAskRecord;

export interface AskRecordGap {
  path: string;
  reason: string;
}

export interface AskRecordScan {
  records: AskRecord[];
  gaps: AskRecordGap[];
}

type AskEntry = { record: AskRecord } | { gap: AskRecordGap } | undefined;

export interface AskRecordChange {
  record: AskRecord;
  changed: boolean;
}

export interface ChangeAskOptions {
  afterRead?: () => Promise<void>;
  onWaiting?: () => void;
}

const choiceOutcomeSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('answered'),
    label: Type.String(),
    confidence: Type.Number(),
  }),
  Type.Object({ kind: Type.Literal('timeout') }),
  Type.Object({ kind: Type.Literal('error') }),
  Type.Object({ kind: Type.Literal('unavailable') }),
]);

const architectOwnerSchema = Type.Object(
  {
    lockToken: Type.String(),
    mode: Type.Union([Type.Literal('visible'), Type.Literal('ask')]),
    terminal: Type.Union([Type.String(), Type.Null()]),
    sessionId: Type.String(),
  },
  { additionalProperties: false },
);

export type ArchitectOwner = Static<typeof architectOwnerSchema>;

const architectRecordV1Schema = Type.Object({
  version: Type.Literal(1),
  sessionFile: Type.Union([Type.String(), Type.Null()]),
  terminal: Type.Union([Type.String(), Type.Null()]),
  leadTerminal: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.String(),
});

const architectRecordV2Schema = Type.Object(
  {
    version: Type.Literal(2),
    sessionFile: Type.Union([Type.String(), Type.Null()]),
    leadTerminal: Type.Union([Type.String(), Type.Null()]),
    owner: Type.Union([architectOwnerSchema, Type.Null()]),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);

const architectRecordSchema = Type.Union([architectRecordV1Schema, architectRecordV2Schema]);

export type ArchitectRecord = Static<typeof architectRecordV2Schema>;

export type SavedArchitectRecord = Static<typeof architectRecordSchema>;

const gateRecordSchema = Type.Object({
  version: Type.Literal(1),
  createdAt: Type.String(),
  request: Type.String(),
  restatement: Type.String(),
  outcome: choiceOutcomeSchema,
  decision: Type.Union([
    Type.Literal('specified'),
    Type.Literal('open'),
    Type.Literal('uncertain'),
  ]),
  label: Type.Union([Type.String(), Type.Null()]),
  confidence: Type.Union([Type.Number(), Type.Null()]),
});

export type GateRecord = Static<typeof gateRecordSchema>;

const askStatusSchema = Type.Union([
  Type.Literal('running'),
  Type.Literal('sent'),
  Type.Literal('timeout'),
  Type.Literal('failed'),
]);

export type AskStatus = Static<typeof askStatusSchema>;

const hiddenAskFields = {
  askId: Type.String(),
  createdAt: Type.String(),
  question: Type.String(),
  sessionFile: Type.String(),
  terminal: Type.Union([Type.String(), Type.Null()]),
  leadTerminal: Type.String(),
  deadline: Type.Number(),
  status: askStatusSchema,
  detail: Type.Union([Type.String(), Type.Null()]),
  answer: Type.Union([Type.String(), Type.Null()]),
};

const askRecordV1Schema = Type.Object({
  version: Type.Literal(1),
  ...hiddenAskFields,
});

const hiddenAskRecordSchema = Type.Object(
  {
    version: Type.Literal(2),
    route: Type.Literal('hidden'),
    ...hiddenAskFields,
  },
  { additionalProperties: false },
);

const liveAskStatusSchema = Type.Union([
  Type.Literal('sending'),
  Type.Literal('queued'),
  Type.Literal('unknown'),
  Type.Literal('answered'),
  Type.Literal('failed'),
]);

type LiveAskStatus = Static<typeof liveAskStatusSchema>;

const liveAskRecordSchema = Type.Object(
  {
    version: Type.Literal(2),
    route: Type.Literal('live'),
    askId: Type.String(),
    createdAt: Type.String(),
    question: Type.String(),
    leadTerminal: Type.String(),
    leadSessionId: Type.String(),
    architectTerminal: Type.String(),
    architectSessionId: Type.String(),
    architectLockToken: Type.String(),
    status: liveAskStatusSchema,
    detail: Type.Union([Type.String(), Type.Null()]),
    answer: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

const askRecordSchema = Type.Union([askRecordV1Schema, hiddenAskRecordSchema, liveAskRecordSchema]);

export type HiddenAskRecord = Static<typeof hiddenAskRecordSchema>;

export type LiveAskRecord = Static<typeof liveAskRecordSchema>;

const toAskRecord = (record: Static<typeof askRecordSchema>): AskRecord =>
  record.version === 1
    ? {
        version: 2,
        route: 'hidden',
        askId: record.askId,
        createdAt: record.createdAt,
        question: record.question,
        sessionFile: record.sessionFile,
        terminal: record.terminal,
        leadTerminal: record.leadTerminal,
        deadline: record.deadline,
        status: record.status,
        detail: record.detail,
        answer: record.answer,
      }
    : record;

export const architectRecordPath = (root: string): string =>
  join(root, '.tau', 'architect', 'record.json');

export const gateRecordDirectory = (root: string): string => join(root, '.tau', 'lead', 'gate');

export const askRecordDirectory = (root: string): string => join(root, '.tau', 'lead', 'ask');

export const askRecordPath = (root: string, askId: string): string =>
  join(askRecordDirectory(root), `${askId}.json`);

const recordOptions = {
  label: 'architect record',
  version: 2,
  schema: architectRecordSchema,
} as const;

export const readArchitectRecord = (root: string): Promise<SavedArchitectRecord | undefined> =>
  readVersionedRecord(architectRecordPath(root), recordOptions);

export const writeArchitectRecord = async (
  root: string,
  record: ArchitectRecord,
): Promise<void> => {
  await ensureTauDirectory(root, 'architect');
  await writeRecord(architectRecordPath(root), record);
};

export const readGateRecord = (root: string, name: string): Promise<GateRecord | undefined> =>
  readVersionedRecord(join(gateRecordDirectory(root), name), {
    label: 'gate record',
    version: 1,
    schema: gateRecordSchema,
  });

export const writeGateRecord = async (root: string, record: GateRecord): Promise<string> => {
  await ensureTauDirectory(root, 'lead/gate');

  const path = join(gateRecordDirectory(root), `${randomUUID()}.json`);

  await writeRecord(path, record);

  return path;
};

const askRecordProblem = (path: string, value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const askId = value['askId'];

  if (typeof askId !== 'string') {
    return undefined;
  }

  if (!isUuid(askId)) {
    return `askId ${askId} is not a UUID`;
  }

  const name = basename(path, '.json');

  return name === askId ? undefined : `askId ${askId} does not match file name ${name}.json`;
};

export const readAskRecordAt = async (path: string): Promise<AskRecord | undefined> => {
  const record = await readVersionedRecord(path, {
    label: 'ask record',
    version: 2,
    schema: askRecordSchema,
    check: (value) => askRecordProblem(path, value),
  });

  return record === undefined ? undefined : toAskRecord(record);
};

export const writeAskRecordAt = (path: string, record: AskRecord): Promise<void> =>
  writeRecord(path, record);

export const readAskRecord = (root: string, askId: string): Promise<AskRecord | undefined> =>
  readAskRecordAt(askRecordPath(root, askId));

export const writeAskRecord = async (root: string, record: AskRecord): Promise<void> => {
  await ensureTauDirectory(root, 'lead/ask');
  await writeAskRecordAt(askRecordPath(root, record.askId), record);
};

const askLockPath = (root: string, askId: string): string => `${askRecordPath(root, askId)}.lock`;

// One ask changes under its own cross-process lock, so a writer never reopens a record that
// another process answered or failed after this writer read it.
export const changeAskRecord = async (
  root: string,
  askId: string,
  change: (current: AskRecord) => AskRecord | undefined,
  options: ChangeAskOptions = {},
): Promise<AskRecordChange | undefined> =>
  withFileLock(
    {
      lockPath: askLockPath(root, askId),
      checkout: root,
      pollMilliseconds: 10,
      signal: undefined,
      cancelled: () => new Error(`The ask lock for ${askId} was cancelled.`),
      onWaiting: options.onWaiting ?? (() => undefined),
    },
    async () => {
      const current = await readAskRecord(root, askId);

      if (current === undefined) {
        return undefined;
      }

      await options.afterRead?.();

      const next = change(current);

      if (next === undefined) {
        return { record: current, changed: false };
      }

      await writeAskRecord(root, next);

      return { record: next, changed: true };
    },
  );

export const readAskRecords = async (root: string): Promise<AskRecordScan> => {
  const names = await readdir(askRecordDirectory(root)).catch((error: unknown) => {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  });

  const fileReads = names
    .filter((name) => name.endsWith('.json'))
    .map(async (name): Promise<AskEntry> => {
      const path = join(askRecordDirectory(root), name);

      try {
        const record = await readAskRecordAt(path);

        return record === undefined ? undefined : { record };
      } catch (error) {
        return { gap: { path, reason: errorMessage(error) } };
      }
    });

  const entries = await Promise.all(fileReads);

  const records: AskRecord[] = [];
  const gaps: AskRecordGap[] = [];

  for (const entry of entries) {
    if (entry === undefined) {
      continue;
    }

    if ('record' in entry) {
      records.push(entry.record);
    } else {
      gaps.push(entry.gap);
    }
  }

  return {
    records: records.toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.askId.localeCompare(right.askId),
    ),
    gaps,
  };
};

const openLiveAskStatuses = new Set<LiveAskStatus>(['sending', 'queued', 'unknown']);

export const isOpenLiveAskStatus = (status: LiveAskStatus): boolean =>
  openLiveAskStatuses.has(status);

export const isOpenLiveAsk = (record: AskRecord): record is LiveAskRecord =>
  record.route === 'live' && isOpenLiveAskStatus(record.status);

export const readOpenLiveAsks = async (
  root: string,
  architectSessionId: string,
): Promise<LiveAskRecord[]> => {
  const { records } = await readAskRecords(root);

  return records.filter(
    (record): record is LiveAskRecord =>
      isOpenLiveAsk(record) && record.architectSessionId === architectSessionId,
  );
};
