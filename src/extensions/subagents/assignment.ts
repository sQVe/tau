import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { isMissingFile } from '../../errors.js';
import { readVersionedRecord, writeRecord } from '../../record.js';
import { describeSchemaProblem, isRecord } from '../../schema.js';
import { loadoutSchema, routingSchema, savedReportSchema, text } from './types.js';

export type SavedReport = Static<typeof savedReportSchema>;

export interface SavedQuestion {
  questionId: string;
  text: string;
  askedAt: number;
}

export interface PiSessionSeed {
  file: string;
  id: string;
  cwd: string;
  parentSession: string;
  createdAt: number;
}

const checkoutHashLength = 8;

const checkoutRoot = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));

export const checkoutFolder = `${basename(checkoutRoot)}-${createHash('sha256').update(checkoutRoot).digest('hex').slice(0, checkoutHashLength)}`;

const assignmentVersion = 3;

const assignmentFileName = 'assignment.json';

export const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

const savedQuestionSchema = Type.Object(
  {
    questionId: Type.String({ pattern: uuidPattern }),
    text,
    askedAt: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const assignmentFields = {
  assignmentId: Type.String({ pattern: uuidPattern }),
  task: text,
  acceptance: Type.Array(text, { maxItems: 50 }),
  label: Type.Union([Type.String({ minLength: 1, maxLength: 120 }), Type.Null()]),
  profile: text,
  loadout: loadoutSchema,
  routing: Type.Union([routingSchema, Type.Null()]),
  packageSnapshot: Type.Union([text, Type.Null()]),
  session: Type.Object(
    { file: text, id: Type.String({ pattern: uuidPattern }) },
    { additionalProperties: false },
  ),
  parentSession: text,
  cwd: text,
  parentTerminal: text,
  deadline: Type.Integer({ minimum: 1 }),
  createdAt: Type.Integer({ minimum: 1 }),
  report: Type.Union([savedReportSchema, Type.Null()]),
};

const extensionPackageSchema = Type.Object(
  { source: text, path: text },
  { additionalProperties: false },
);

const assignmentVersion1Schema = Type.Object(
  { version: Type.Literal(1), ...assignmentFields },
  { additionalProperties: false },
);

const assignmentVersion2Schema = Type.Object(
  {
    version: Type.Literal(2),
    ...assignmentFields,
    questions: Type.Array(savedQuestionSchema),
  },
  { additionalProperties: false },
);

const assignmentSchema = Type.Object(
  {
    version: Type.Literal(assignmentVersion),
    ...assignmentFields,
    previousAssignmentId: Type.Union([Type.String({ pattern: uuidPattern }), Type.Null()]),
    extensionPackages: Type.Union([Type.Array(extensionPackageSchema), Type.Null()]),
    questions: Type.Array(savedQuestionSchema),
  },
  { additionalProperties: false },
);

export type Assignment = Static<typeof assignmentSchema>;

type AssignmentVersion1 = Static<typeof assignmentVersion1Schema>;

type AssignmentVersion2 = Static<typeof assignmentVersion2Schema>;

const isAssignmentVersion1 = (value: unknown): boolean => isRecord(value) && value['version'] === 1;

const isAssignmentVersion2 = (value: unknown): boolean => isRecord(value) && value['version'] === 2;

const fromVersion1 = (assignment: AssignmentVersion1): Assignment => ({
  ...assignment,
  version: assignmentVersion,
  previousAssignmentId: null,
  extensionPackages: null,
  questions: [],
});

const fromVersion2 = (assignment: AssignmentVersion2): Assignment => ({
  ...assignment,
  version: assignmentVersion,
  previousAssignmentId: null,
  extensionPackages: null,
});

export const seedSession = (seed: PiSessionSeed): void => {
  const header = {
    type: 'session',
    version: 3,
    id: seed.id,
    timestamp: new Date(seed.createdAt).toISOString(),
    cwd: seed.cwd,
    parentSession: seed.parentSession,
  };

  writeFileSync(seed.file, `${JSON.stringify(header)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
};

export const assignmentDirectory = (assignmentId: string): string =>
  join(getAgentDir(), 'tau', checkoutFolder, 'assignments', assignmentId);

export const assignmentPath = (assignmentId: string): string =>
  join(assignmentDirectory(assignmentId), assignmentFileName);

export const readAssignment = async (path: string): Promise<Assignment | undefined> => {
  const record = await readVersionedRecord(path, {
    label: 'assignment',
    version: assignmentVersion,
    schema: (value) => {
      if (isAssignmentVersion1(value)) {
        return assignmentVersion1Schema;
      }

      return isAssignmentVersion2(value) ? assignmentVersion2Schema : assignmentSchema;
    },
  });

  if (record === undefined) {
    return undefined;
  }

  if (record.version === 1) {
    return fromVersion1(record);
  }

  return record.version === 2 ? fromVersion2(record) : record;
};

const checkAssignment = (path: string, assignment: Assignment): void => {
  if (!Value.Check(assignmentSchema, assignment)) {
    throw new Error(
      `Malformed assignment ${path}: ${describeSchemaProblem(assignmentSchema, assignment)}.`,
    );
  }
};

// Creates the folder and the session file before the assignment file, so a saved assignment always
// has its session.
export const writeAssignment = async (assignment: Assignment): Promise<void> => {
  const path = assignmentPath(assignment.assignmentId);

  checkAssignment(path, assignment);

  const directory = assignmentDirectory(assignment.assignmentId);
  const sessionFile = join(directory, `${assignment.session.id}.jsonl`);

  if (assignment.session.file !== sessionFile) {
    throw new Error(
      `Assignment ${assignment.assignmentId} must keep its session file in its folder: ${sessionFile}.`,
    );
  }

  mkdirSync(directory, { recursive: true, mode: 0o700 });

  seedSession({
    file: sessionFile,
    id: assignment.session.id,
    cwd: assignment.cwd,
    parentSession: assignment.parentSession,
    createdAt: assignment.createdAt,
  });

  await writeRecord(path, assignment);
};

const headerReadLimit = 65_536;

const readFirstLine = (file: string): string => {
  const buffer = Buffer.alloc(headerReadLimit);
  const descriptor = openSync(file, 'r');

  try {
    const length = readSync(descriptor, buffer, 0, headerReadLimit, 0);

    return buffer.subarray(0, length).toString('utf8').split('\n')[0] ?? '';
  } finally {
    closeSync(descriptor);
  }
};

const isSessionHeader = (line: string): boolean => {
  try {
    const header: unknown = JSON.parse(line);

    return isRecord(header) && header['type'] === 'session';
  } catch {
    return false;
  }
};

// Pi starts a new, empty conversation from a file without a session header, so the follow-up
// would lose the worker's context without an error.
const sessionFileProblem = (file: string): string | undefined => {
  let isFile: boolean;

  try {
    isFile = statSync(file).isFile();
  } catch (error) {
    if (isMissingFile(error)) {
      return 'is missing';
    }

    throw error;
  }

  if (!isFile) {
    return 'is not a regular file';
  }

  if (!isSessionHeader(readFirstLine(file))) {
    return 'has no Pi session header';
  }

  return undefined;
};

export const writeFollowUpAssignment = async (assignment: Assignment): Promise<void> => {
  const path = assignmentPath(assignment.assignmentId);

  checkAssignment(path, assignment);

  if (assignment.previousAssignmentId === null) {
    throw new Error(
      `Follow-up assignment ${assignment.assignmentId} needs a previous assignment ID.`,
    );
  }

  const problem = sessionFileProblem(assignment.session.file);

  if (problem !== undefined) {
    throw new Error(
      `Follow-up assignment ${assignment.assignmentId} session file ${problem}: ${assignment.session.file}.`,
    );
  }

  mkdirSync(assignmentDirectory(assignment.assignmentId), { recursive: true, mode: 0o700 });

  await writeRecord(path, assignment);
};

export const saveQuestion = async (path: string, question: SavedQuestion): Promise<void> => {
  if (!Value.Check(savedQuestionSchema, question)) {
    throw new Error(
      `Malformed question for ${path}: ${describeSchemaProblem(savedQuestionSchema, question)}.`,
    );
  }

  const assignment = await readAssignment(path);

  if (assignment === undefined) {
    throw new Error(`Missing assignment ${path}; no question can be saved.`);
  }

  await writeRecord(path, { ...assignment, questions: [...assignment.questions, question] });
};

export const saveReport = async (path: string, report: SavedReport): Promise<void> => {
  if (!Value.Check(savedReportSchema, report)) {
    throw new Error(
      `Malformed report for ${path}: ${describeSchemaProblem(savedReportSchema, report)}.`,
    );
  }

  const assignment = await readAssignment(path);

  if (assignment === undefined) {
    throw new Error(`Missing assignment ${path}; no report can be saved.`);
  }

  await writeRecord(path, { ...assignment, report });
};
