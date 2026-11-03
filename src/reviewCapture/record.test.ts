import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { errorMessage } from '../errors.js';
import { parseCaptureRecord, recordFileName } from './record.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'records');
const recordPath = join('/review', recordFileName);

const fixtureText = (fixture: string) => readFileSync(join(fixtures, fixture), 'utf8');

const parseText = (text: string) => parseCaptureRecord(recordPath, text);

const parseRecord = (record: unknown) => parseText(JSON.stringify(record));

const parseError = (parse: () => unknown) => {
  try {
    parse();
  } catch (error) {
    return error;
  }

  return undefined;
};

it('reads a version 1 record', () => {
  const text = fixtureText('version-1.json');

  expect(parseText(text)).toEqual(JSON.parse(text));
});

it.each([
  'version-2.json',
  'version-2-fix.json',
  'version-3.json',
  'version-4.json',
  'version-5.json',
  'version-5-fix.json',
])('reads the %s record', (fixture) => {
  const text = fixtureText(fixture);

  expect(parseText(text)).toEqual(JSON.parse(text));
});

it('refuses a version 1 record that holds a fix target', () => {
  const fix = JSON.parse(fixtureText('version-2-fix.json')) as object;

  expect(() => parseRecord({ ...fix, version: 1 })).toThrow('/target');
});

it('reads a version 2 record', () => {
  const record = {
    version: 2 as const,
    target: { kind: 'range' as const, from: 'a'.repeat(40), to: 'b'.repeat(40) },
    base: 'a'.repeat(40),
    head: 'c'.repeat(40),
    hash: 'd'.repeat(40),
  };

  expect(parseRecord(record)).toEqual(record);
});

it.each(['malformed.json', 'newer.json'])('refuses the %s record', (fixture) => {
  expect(() => parseText(fixtureText(fixture))).toThrow(recordPath);
});

it('refuses a saved target revision that is not a full object name and names the field', () => {
  expect(() => parseText(fixtureText('option-revision.json'))).toThrow('/target/base');
});

it('refuses a record that is not JSON', () => {
  expect(() => parseText('{"version": 1,')).toThrow(recordPath);
});

const sha = 'a'.repeat(40);

const savedSnapshot = {
  present: ['src/kept.ts'],
  absent: ['src/gone.ts'],
  skipped: [{ kind: 'binary', path: 'image.png', identity: sha, existed: true }],
};

const savedRecord = (fixture: string) =>
  JSON.parse(fixtureText(fixture)) as Record<string, unknown>;

const refusal = (record: unknown) => {
  const error = parseError(() => parseRecord(record));

  expect(error).toBeInstanceOf(Error);

  return errorMessage(error);
};

it('reads a record that holds a snapshot', () => {
  const record = { ...savedRecord('version-2-fix.json'), snapshot: savedSnapshot };

  expect(parseRecord(record)).toEqual(record);
});

describe('refuses a saved record', () => {
  const fix = savedRecord('version-2-fix.json');
  const versionFour = savedRecord('version-4.json');
  const completeEndpoint = versionFour['endpoint'] as Record<string, unknown>;
  const chainedFix = savedRecord('version-5-fix.json');
  const chainedTarget = chainedFix['target'] as Record<string, unknown>;
  const predecessor = chainedTarget['predecessor'] as Record<string, unknown>;

  const invalidRecords = {
    'with a field it does not define': { ...fix, extra: 1 },
    'of version 1 with a field it does not define': {
      ...savedRecord('version-1.json'),
      extra: 1,
    },
    'with a snapshot field it does not define': {
      ...fix,
      snapshot: { ...savedSnapshot, extra: 1 },
    },
    'with a skipped path field it does not define': {
      ...fix,
      snapshot: { ...savedSnapshot, skipped: [{ ...savedSnapshot.skipped[0], extra: 1 }] },
    },
    'with an empty present path': { ...fix, snapshot: { ...savedSnapshot, present: [''] } },
    'with an empty absent path': { ...fix, snapshot: { ...savedSnapshot, absent: [''] } },
    'with an empty skipped path': {
      ...fix,
      snapshot: { ...savedSnapshot, skipped: [{ ...savedSnapshot.skipped[0], path: '' }] },
    },
    'of version 4 with no endpoint': { ...versionFour, endpoint: undefined },
    'of version 3 with an endpoint': {
      ...savedRecord('version-3.json'),
      endpoint: completeEndpoint,
    },
    'with a complete endpoint that names no ref': {
      ...versionFour,
      endpoint: { ...completeEndpoint, ref: undefined },
    },
    'with a complete endpoint that names no tree': {
      ...versionFour,
      endpoint: { ...completeEndpoint, tree: undefined },
    },
    'of version 4 with a predecessor': { ...chainedFix, version: 4 },
    'with a predecessor that names no endpoint tree': {
      ...chainedFix,
      target: { ...chainedTarget, predecessor: { ...predecessor, endpointTree: undefined } },
    },
    'with a predecessor field it does not define': {
      ...chainedFix,
      target: { ...chainedTarget, predecessor: { ...predecessor, extra: 1 } },
    },
    'with an unsupported endpoint that names no reason': {
      ...versionFour,
      endpoint: { status: 'unsupported', reasons: [] },
    },
  };

  it.each(Object.entries(invalidRecords))('%s', (_name, record) => {
    expect(() => parseRecord(record)).toThrow('Malformed capture record');
  });
});

it('refuses a version 3 record that names no original artifact', () => {
  const record = { ...savedRecord('version-3.json'), original: undefined };

  expect(() => parseRecord(record)).toThrow('Malformed capture record');
});

it.each(['null', '7', '"text"', '[]'])('refuses the JSON value %s as malformed', (text) => {
  expect(() => parseText(text)).toThrow('Malformed capture record');
});

it('names the field of a bad target in a record that is otherwise valid', () => {
  const record = savedRecord('version-2-fix.json');
  const target = record['target'] as Record<string, unknown>;

  const message = refusal({ ...record, target: { ...target, base: 'HEAD' } });

  expect(message).toContain('/target/base');
});

it('names the first bad field when the target kind is unknown', () => {
  const record = savedRecord('version-2-fix.json');

  const message = refusal({ ...record, target: { kind: 'stash' } });

  expect(message).toContain('Malformed capture record');
  expect(message).not.toContain('/target/base');
});

it('names the record field when only the target is valid', () => {
  const record = savedRecord('version-2-fix.json');

  const message = refusal({ ...record, hash: 'short' });

  expect(message).toContain('/hash');
});

it('names a newer record format, not a malformed record', () => {
  const error = parseError(() => parseText(fixtureText('newer.json')));

  expect(errorMessage(error)).not.toContain('Malformed');
});

it('does not call a record with a non-number version newer', () => {
  const message = refusal({ ...savedRecord('version-2.json'), version: '3' });

  expect(message).toContain('Malformed capture record');
});
