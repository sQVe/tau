import { isRecord } from '../src/schema.ts';

export interface WorkerTask {
  taskId: string;
  harness: string;
  name: string;
  profile: string;
  createdAt: number;
  sessionFile: string | undefined;
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

const isOptionalText = (value: unknown) => value === undefined || typeof value === 'string';

const parseRecord = (source: string) => {
  let record: unknown;

  try {
    record = JSON.parse(source);
  } catch {
    return undefined;
  }

  return isRecord(record) ? record : undefined;
};

const parseLoadout = (record: Record<string, unknown>) => {
  const loadout = record.loadout ?? {};

  return isRecord(loadout) ? loadout : undefined;
};

const sessionFileOf = (record: Record<string, unknown>) =>
  isRecord(record.session) ? text(record.session.file) : undefined;

export const parseWorkerTask = (source: string): WorkerTask | undefined => {
  const record = parseRecord(source);

  if (record === undefined) {
    return undefined;
  }

  const taskId = text(record.taskId);

  if (taskId === undefined || typeof record.createdAt !== 'number') {
    return undefined;
  }

  const loadout = parseLoadout(record);

  if (loadout === undefined) {
    return undefined;
  }

  // Older records omit these fields; a present field of another type is a broken record.
  const optionalFields = [record.name, record.nativeSessionFile, loadout.profile, loadout.harness];

  if (!optionalFields.every(isOptionalText)) {
    return undefined;
  }

  return {
    taskId,
    harness: text(loadout.harness) ?? 'pi',
    name: text(record.name) ?? taskId,
    profile: text(loadout.profile) ?? 'unknown',
    createdAt: record.createdAt,
    sessionFile: text(record.nativeSessionFile),
  };
};

export const parseAssignment = (source: string): WorkerTask | undefined => {
  const record = parseRecord(source);

  if (record === undefined) {
    return undefined;
  }

  const assignmentId = text(record.assignmentId);

  if (assignmentId === undefined || typeof record.createdAt !== 'number') {
    return undefined;
  }

  const sessionFile = sessionFileOf(record);

  if (sessionFile === undefined) {
    return undefined;
  }

  const loadout = parseLoadout(record);

  if (loadout === undefined) {
    return undefined;
  }

  const label = record.label ?? undefined;

  if (![label, record.profile, loadout.harness].every(isOptionalText)) {
    return undefined;
  }

  return {
    taskId: assignmentId,
    harness: text(loadout.harness) ?? 'pi',
    name: text(label) ?? assignmentId,
    profile: text(record.profile) ?? 'unknown',
    createdAt: record.createdAt,
    sessionFile,
  };
};

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

// A follow-up names its predecessor's session file, and older records keep it beside the task
// record. Records copied from another agent directory keep stale absolute paths, so compare the
// file name, which is the unique native session ID.
export const ownsSession = (
  task: WorkerTask,
  taskDirectory: string,
  sessionPath: string,
): boolean => {
  const named =
    task.sessionFile !== undefined && fileName(task.sessionFile) === fileName(sessionPath);

  return named || `${taskDirectory}/${fileName(sessionPath)}` === sessionPath;
};
