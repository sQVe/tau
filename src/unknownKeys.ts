import { isRecord } from './isRecord.js';

// A key set to `true` is a known leaf. A nested object lists the known keys below it. The key `*`
// describes every key not listed, for objects that map free names to entries.
export interface KnownKeys {
  readonly [key: string]: KnownKeys | true;
}

export const anyKey = '*';

// Full key paths below `path` that `known` does not list, at any depth. A value that is not an
// object has no keys to check; its type is the reader's concern.
export const findUnknownKeys = (value: unknown, known: KnownKeys, path: string): string[] => {
  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) => {
    const keyPath = `${path}.${key}`;
    const expected = Object.hasOwn(known, key) ? known[key] : known[anyKey];

    if (expected === undefined) {
      return [keyPath];
    }

    return expected === true ? [] : findUnknownKeys(child, expected, keyPath);
  });
};

export const reportedId = (file: string, path: string): string => `${file}\n${path}`;

// The key paths of `file` that were not reported before. Reported keys are `file` and path pairs.
export const unreportedKeys = (
  reported: ReadonlySet<string>,
  file: string,
  paths: readonly string[],
): string[] => [...new Set(paths)].filter((path) => !reported.has(reportedId(file, path)));
