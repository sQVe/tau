import { isRecord } from '../../../schema.js';

interface CargoTarget {
  kinds: string[];
}

export interface CargoMetadata {
  workspaceRoot: string;
  targets: CargoTarget[];
}

const textField = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];

  return typeof value === 'string' && value !== '' ? value : null;
};

const stringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;

const targetsOf = (packageRecord: unknown): CargoTarget[] | null => {
  if (!isRecord(packageRecord) || !Array.isArray(packageRecord['targets'])) {
    return null;
  }

  const targets: CargoTarget[] = [];

  for (const target of packageRecord['targets']) {
    if (!isRecord(target)) {
      return null;
    }

    const kinds = stringArray(target['kind']);

    if (kinds === null) {
      return null;
    }

    targets.push({ kinds });
  }

  return targets;
};

export const parseCargoMetadata = (stdout: string): CargoMetadata | null => {
  let document: unknown;

  try {
    document = JSON.parse(stdout);
  } catch {
    return null;
  }

  if (!isRecord(document) || !Array.isArray(document['packages'])) {
    return null;
  }

  const workspaceRoot = textField(document, 'workspace_root');

  if (workspaceRoot === null) {
    return null;
  }

  const targets: CargoTarget[] = [];

  for (const packageRecord of document['packages']) {
    const parsed = targetsOf(packageRecord);

    if (parsed === null) {
      return null;
    }

    targets.push(...parsed);
  }

  return { workspaceRoot, targets };
};
