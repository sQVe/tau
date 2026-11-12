import { describe, expect, it } from 'vitest';

import { ownsSession, parseAssignment, parseWorkerTask } from './workerRecord.js';
import type { WorkerTask } from './workerRecord.js';

const task: WorkerTask = {
  taskId: 't',
  harness: 'pi',
  name: 't',
  profile: 'worker',
  createdAt: 11,
  sessionFile: undefined,
};

describe('parseWorkerTask', () => {
  it.each([
    {
      rule: 'reads a current record',
      source:
        '{"taskId":"t","name":"scout-1","createdAt":5,"nativeSessionFile":"/w/s.jsonl","loadout":{"profile":"scout"}}',
      parsed: {
        taskId: 't',
        harness: 'pi',
        name: 'scout-1',
        profile: 'scout',
        createdAt: 5,
        sessionFile: '/w/s.jsonl',
      },
    },
    {
      rule: 'reads an old record without a session file or profile',
      source: '{"taskId":"t","createdAt":5}',
      parsed: {
        taskId: 't',
        harness: 'pi',
        name: 't',
        profile: 'unknown',
        createdAt: 5,
        sessionFile: undefined,
      },
    },
    {
      rule: 'reads the harness of a Codex worker',
      source: '{"taskId":"t","createdAt":5,"loadout":{"harness":"generic","profile":"worker"}}',
      parsed: {
        taskId: 't',
        harness: 'generic',
        name: 't',
        profile: 'worker',
        createdAt: 5,
        sessionFile: undefined,
      },
    },
    {
      rule: 'rejects a profile that is not text',
      source: '{"taskId":"t","createdAt":5,"loadout":{"profile":7}}',
      parsed: undefined,
    },
    {
      rule: 'rejects a harness that is not text',
      source: '{"taskId":"t","createdAt":5,"loadout":{"harness":["generic"]}}',
      parsed: undefined,
    },
    {
      rule: 'rejects a session file that is not text',
      source: '{"taskId":"t","createdAt":5,"nativeSessionFile":null}',
      parsed: undefined,
    },
    {
      rule: 'rejects a loadout that is not an object',
      source: '{"taskId":"t","createdAt":5,"loadout":"pi"}',
      parsed: undefined,
    },
    { rule: 'rejects a record without a start time', source: '{"taskId":"t"}', parsed: undefined },
    { rule: 'rejects malformed JSON', source: '{"taskId":', parsed: undefined },
  ])('$rule', ({ source, parsed }) => {
    expect(parseWorkerTask(source)).toEqual(parsed);
  });
});

describe('parseAssignment', () => {
  const current = {
    version: 3,
    assignmentId: 'a',
    label: 'scout-1',
    profile: 'scout',
    loadout: { harness: 'pi' },
    session: { file: '/w/a/s.jsonl', id: 's' },
    createdAt: 5,
  };

  const parsed = {
    taskId: 'a',
    harness: 'pi',
    name: 'scout-1',
    profile: 'scout',
    createdAt: 5,
    sessionFile: '/w/a/s.jsonl',
  };

  it.each([
    { rule: 'reads a current record', record: current, expected: parsed },
    {
      rule: 'names a record with a null label by its assignment',
      record: { ...current, label: null },
      expected: { ...parsed, name: 'a' },
    },
    {
      rule: 'names a record without a label by its assignment',
      record: { ...current, label: undefined },
      expected: { ...parsed, name: 'a' },
    },
    {
      rule: 'reads a record without a profile or loadout',
      record: { ...current, profile: undefined, loadout: undefined },
      expected: { ...parsed, profile: 'unknown' },
    },
    {
      rule: 'reads the harness of a Codex worker',
      record: { ...current, loadout: { harness: 'generic' } },
      expected: { ...parsed, harness: 'generic' },
    },
    { rule: 'reads a version 1 record', record: { ...current, version: 1 }, expected: parsed },
    { rule: 'reads a version 2 record', record: { ...current, version: 2 }, expected: parsed },
    {
      rule: 'rejects a record without a version',
      record: { ...current, version: undefined },
      expected: undefined,
    },
    {
      rule: 'rejects a newer version',
      record: { ...current, version: 4 },
      expected: undefined,
    },
    {
      rule: 'rejects a version that is not an integer',
      record: { ...current, version: 2.5 },
      expected: undefined,
    },
    {
      rule: 'rejects a version that is not a number',
      record: { ...current, version: '3' },
      expected: undefined,
    },
    {
      rule: 'rejects a record without an assignment',
      record: { ...current, assignmentId: undefined },
      expected: undefined,
    },
    {
      rule: 'rejects an assignment that is not text',
      record: { ...current, assignmentId: 7 },
      expected: undefined,
    },
    {
      rule: 'rejects a record without a start time',
      record: { ...current, createdAt: undefined },
      expected: undefined,
    },
    {
      rule: 'rejects a start time that is not a number',
      record: { ...current, createdAt: '5' },
      expected: undefined,
    },
    {
      rule: 'rejects a record without a session',
      record: { ...current, session: undefined },
      expected: undefined,
    },
    {
      rule: 'rejects a session without a file',
      record: { ...current, session: { id: 's' } },
      expected: undefined,
    },
    {
      rule: 'rejects a session file that is not text',
      record: { ...current, session: { file: null } },
      expected: undefined,
    },
    {
      rule: 'rejects a label that is not text',
      record: { ...current, label: 7 },
      expected: undefined,
    },
    {
      rule: 'rejects a profile that is not text',
      record: { ...current, profile: 7 },
      expected: undefined,
    },
    {
      rule: 'rejects a harness that is not text',
      record: { ...current, loadout: { harness: ['generic'] } },
      expected: undefined,
    },
    {
      rule: 'rejects a loadout that is not an object',
      record: { ...current, loadout: 'pi' },
      expected: undefined,
    },
    { rule: 'rejects a record that is not an object', record: [current], expected: undefined },
  ])('$rule', ({ record, expected }) => {
    expect(parseAssignment(JSON.stringify(record))).toEqual(expected);
  });

  it('rejects malformed JSON', () => {
    expect(parseAssignment('{"assignmentId":')).toBeUndefined();
  });
});

describe('ownsSession', () => {
  it.each([
    {
      rule: 'owns the session beside its record',
      directory: '/w/a',
      sessionFile: undefined,
      owns: true,
    },
    {
      rule: 'owns the session a follow-up names',
      directory: '/w/b',
      sessionFile: '/w/a/s.jsonl',
      owns: true,
    },
    {
      rule: 'owns a session named by a copied record',
      directory: '/w/b',
      sessionFile: '/old/w/a/s.jsonl',
      owns: true,
    },
    {
      rule: 'does not own another session',
      directory: '/w/c',
      sessionFile: '/w/c/other.jsonl',
      owns: false,
    },
  ])('$rule', ({ directory, sessionFile, owns }) => {
    expect(ownsSession({ ...task, sessionFile }, directory, '/w/a/s.jsonl')).toBe(owns);
  });
});
