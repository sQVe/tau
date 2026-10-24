import { isRecord } from '../../schema.js';

export interface Survivor {
  file: string;
  line: number;
  mutator: string;
  original: string;
  replacement: string;
  covered: boolean;
}

export type MutationStatus = 'pass' | 'survivors' | 'nothing' | 'error';

export interface MutationReport {
  status: MutationStatus;
  error?: string;
  survivors: Survivor[];
  unmutated: string[];
}

const statuses: readonly string[] = ['pass', 'survivors', 'nothing', 'error'];

const isMutationStatus = (value: unknown): value is MutationStatus =>
  typeof value === 'string' && statuses.includes(value);

const readSurvivor = (item: unknown, index: number): Survivor => {
  const where = `survivors[${index}]`;

  if (!isRecord(item)) {
    throw new Error(`The mutation report is invalid: ${where} must be an object.`);
  }

  const { file, line, mutator, original, replacement, covered } = item;

  if (typeof file !== 'string' || typeof mutator !== 'string') {
    throw new TypeError(
      `The mutation report is invalid: ${where} needs a string file and mutator.`,
    );
  }

  if (typeof original !== 'string' || typeof replacement !== 'string') {
    throw new TypeError(
      `The mutation report is invalid: ${where} needs a string original and replacement.`,
    );
  }

  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    throw new TypeError(
      `The mutation report is invalid: ${where} needs an integer line of at least 1.`,
    );
  }

  if (typeof covered !== 'boolean') {
    throw new TypeError(`The mutation report is invalid: ${where} needs a Boolean covered.`);
  }

  return { file, line, mutator, original, replacement, covered };
};

const readStrings = (value: unknown, field: string): string[] => {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`The mutation report is invalid: ${field} must be an array of strings.`);
  }

  return value;
};

// Parses the JSON that the mutation command prints. Fields it does not know are ignored.
export const parseMutationReport = (text: string): MutationReport => {
  let report: unknown;

  try {
    report = JSON.parse(text);
  } catch (error) {
    throw new Error(`The mutation report is not valid JSON (${String(error)}).`, { cause: error });
  }

  if (!isRecord(report)) {
    throw new Error('The mutation report is invalid: it must be a JSON object.');
  }

  if (report.version !== 1) {
    throw new Error('The mutation report is invalid: version must be 1.');
  }

  const { status, survivors, error } = report;

  if (!isMutationStatus(status)) {
    throw new Error(
      `The mutation report is invalid: status must be one of ${statuses.join(', ')}.`,
    );
  }

  if (!Array.isArray(survivors)) {
    throw new TypeError('The mutation report is invalid: survivors must be an array.');
  }

  const survivorList = survivors.map((item, index) => readSurvivor(item, index));
  const unmutated = readStrings(report.unmutated, 'unmutated');
  const passing = status === 'pass' || status === 'nothing';

  // A passing verdict is saved for reuse, so a contradictory report must not pass.
  if (passing && survivorList.length > 0) {
    throw new Error(`The mutation report is invalid: status ${status} must list no survivors.`);
  }

  if (passing && unmutated.length > 0) {
    throw new Error(
      `The mutation report is invalid: status ${status} must list no unmutated files.`,
    );
  }

  return {
    status,
    ...(typeof error === 'string' ? { error } : {}),
    survivors: survivorList,
    unmutated,
  };
};
