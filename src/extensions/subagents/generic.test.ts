import { execFileSync } from 'node:child_process';
import * as fileSystem from 'node:fs';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { fixtureGenericLoadout } from './fixtures/loadout.js';
import {
  acceptGenericReport,
  genericPrompt,
  genericReportPath,
  prepareGenericReport,
  submitGenericText,
} from './generic.js';
import { publish, readGenericSubmission, readReport } from './records.js';
import type { Task } from './types.js';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof fileSystem>();

  return { ...original, readSync: vi.fn<typeof original.readSync>(original.readSync) };
});

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-native-report-'));
  onTestFinished(() => {
    vi.resetAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  const records = join(directory, 'records');
  mkdirSync(records);
  const task: Task = {
    version: 2,
    taskId: 'full-task-id',
    task: 'Inspect.',
    parentSession: join(directory, 'parent.jsonl'),
    parentSessionId: 'parent',
    ownerId: 'owner',
    createdAt: 1000,
    deadline: 20000,
    cancellationBudget: 1000,
    monotonicDeadline: 20000,
    loadout: fixtureGenericLoadout(directory),
  };
  prepareGenericReport(task);
  const path = genericReportPath(task);
  const complete = (outcome = 'success') =>
    `Task: ${task.taskId}\nOutcome: ${outcome}\n\nObserved evidence.\n\nEnd task: ${task.taskId}\n`;

  return { directory, records, task, path, complete };
};

it('requires complete publication and keeps an immutable parent report receipt', () => {
  const setup = fixture();

  expect(acceptGenericReport(setup.records, setup.task)).toBe(false);
  expect(genericPrompt(setup.task)).toContain(setup.path);
  expect(genericPrompt(setup.task)).toContain('Do not write report.md incrementally');
  const partial = join(dirname(setup.path), 'report.partial');
  writeFileSync(partial, setup.complete(), { flag: 'wx' });
  expect(acceptGenericReport(setup.records, setup.task)).toBe(false);
  linkSync(partial, setup.path);
  expect(acceptGenericReport(setup.records, setup.task)).toBe(true);
  const original = readFileSync(join(setup.records, 'report.json'));
  writeFileSync(setup.path, 'Replacement is not a second report.');
  expect(acceptGenericReport(setup.records, setup.task)).toBe(true);
  expect(readFileSync(join(setup.records, 'report.json'))).toEqual(original);
  expect(readReport(setup.records, setup.task.taskId)).toMatchObject({
    outcome: 'success',
    summary: setup.complete(),
    evidence: [setup.path],
  });
});

it('publishes the report under the worker cwd .tau folder and keeps it out of Git', async () => {
  const setup = fixture();
  const repository = await createTemporaryRepository(onTestFinished);
  const task = { ...setup.task, loadout: fixtureGenericLoadout(repository) };

  prepareGenericReport(task);
  writeFileSync(genericReportPath(task), setup.complete(), { flag: 'wx' });

  expect(acceptGenericReport(setup.records, task)).toBe(true);
  expect(readReport(setup.records, task.taskId)?.evidence).toEqual([
    join(repository, '.tau', 'workers', task.taskId, 'report.md'),
  ]);
  expect(
    execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: repository,
      encoding: 'utf8',
    }),
  ).toBe('');
});

it('adds the ignore rule to an existing .tau/.gitignore and keeps its lines', async () => {
  const setup = fixture();
  const repository = await createTemporaryRepository(onTestFinished);
  const task = { ...setup.task, loadout: fixtureGenericLoadout(repository) };
  mkdirSync(join(repository, '.tau'));
  writeFileSync(join(repository, '.tau', '.gitignore'), 'state.json');

  prepareGenericReport(task);
  writeFileSync(genericReportPath(task), setup.complete(), { flag: 'wx' });

  expect(readFileSync(join(repository, '.tau', '.gitignore'), 'utf8')).toBe('state.json\n*\n');
  expect(
    execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: repository,
      encoding: 'utf8',
    }),
  ).toBe('');
});

it.each(['.tau', '.tau/workers'])('refuses a symlinked %s without writing outside cwd', (link) => {
  const setup = fixture();
  const cwd = join(setup.directory, 'cwd');
  const outside = join(setup.directory, 'outside');
  mkdirSync(dirname(join(cwd, link)), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(cwd, link));
  const task = { ...setup.task, loadout: fixtureGenericLoadout(cwd) };

  expect(() => {
    prepareGenericReport(task);
  }).toThrow('symbolic link');
  expect(fileSystem.readdirSync(outside)).toEqual([]);
});

it.each(['failure', 'incomplete'])(
  'accepts a complete explicit %s outcome without calling it success',
  (outcome) => {
    const setup = fixture();
    writeFileSync(setup.path, setup.complete(outcome), { flag: 'wx' });

    expect(acceptGenericReport(setup.records, setup.task)).toBe(true);
    expect(readReport(setup.records, setup.task.taskId)?.outcome).toBe(outcome);
  },
);

it.each([
  '',
  'Task: full-task-id\nOutcome: success\n\nStill writing.',
  'Task: full-task-id\nOutcome: success\n\nEvidence.\n\nEnd task: full-task-id',
])('does not accept an unfinished report %j', (content) => {
  const setup = fixture();
  writeFileSync(setup.path, content);

  expect(acceptGenericReport(setup.records, setup.task)).toBe(false);
  expect(readReport(setup.records, setup.task.taskId)).toBeUndefined();
});

it.each([
  'identity',
  'outcome',
  'evidence',
  'oversize',
  'encoding',
  'directory',
  'symlink',
] as const)('rejects an invalid %s report without a receipt', (failure) => {
  const setup = fixture();
  const contents = {
    identity: setup.complete().replace('Task: full-task-id', 'Task: another-task'),
    outcome: setup.complete('maybe'),
    evidence: setup.complete().replace('Observed evidence.', ''),
    oversize: '界'.repeat(11000),
    encoding: Buffer.from([0xff]),
  };

  if (failure === 'directory') {
    mkdirSync(setup.path);
  } else if (failure === 'symlink') {
    const target = join(setup.directory, 'target');
    writeFileSync(target, setup.complete());
    symlinkSync(target, setup.path);
  } else {
    writeFileSync(setup.path, contents[failure]);
  }

  const errors = {
    identity: 'wrong task identity',
    outcome: 'explicit outcome',
    evidence: 'explicit outcome',
    oversize: 'regular file',
    encoding: 'encoding utf-8',
    directory: 'regular file',
    symlink: 'ELOOP',
  };
  expect(() => acceptGenericReport(setup.records, setup.task)).toThrow(errors[failure]);
  expect(readReport(setup.records, setup.task.taskId)).toBeUndefined();
});

it('accepts an escape-heavy report within the bounded receipt size', () => {
  const setup = fixture();
  const escapedBody = '\u0000'.repeat(9000);
  writeFileSync(
    setup.path,
    `Task: ${setup.task.taskId}\nOutcome: success\n\n${escapedBody}\n\nEnd task: ${setup.task.taskId}\n`,
    { flag: 'wx' },
  );

  expect(Buffer.byteLength(readFileSync(setup.path))).toBeLessThanOrEqual(10_000);
  expect(acceptGenericReport(setup.records, setup.task)).toBe(true);
  expect(readReport(setup.records, setup.task.taskId)?.outcome).toBe('success');
});

it('waits for an in-progress native write instead of accepting or terminating it', async () => {
  const setup = fixture();
  writeFileSync(setup.path, `Task: ${setup.task.taskId}\nOutcome: success\n\nPartial evidence.`);
  const actual = await vi.importActual<typeof fileSystem>('node:fs');
  vi.mocked(fileSystem.readSync).mockImplementationOnce((descriptor, buffer, options) => {
    writeFileSync(setup.path, setup.complete());

    return actual.readSync(descriptor, buffer, options);
  });

  expect(acceptGenericReport(setup.records, setup.task)).toBe(false);
  expect(readReport(setup.records, setup.task.taskId)).toBeUndefined();
  expect(acceptGenericReport(setup.records, setup.task)).toBe(true);
});

it('refuses report-area reuse without overwriting files', () => {
  const setup = fixture();
  writeFileSync(setup.path, 'User evidence.');

  expect(() => {
    prepareGenericReport(setup.task);
  }).toThrow('EEXIST');
  expect(readFileSync(setup.path, 'utf8')).toBe('User evidence.');
});

it.each(['submitted', 'not-delivered', 'uncertain'] as const)(
  'records %s text delivery separately and never resends a saved identity',
  async (state) => {
    const setup = fixture();
    const send = vi.fn<() => Promise<string>>(async () => {
      expect(readGenericSubmission(setup.records, setup.task.taskId, 'reply-one')?.intent).toEqual({
        taskId: setup.task.taskId,
        id: 'reply-one',
        text: 'Scoped answer.',
      });

      if (state !== 'submitted') {
        throw Object.assign(new Error('Delivery failed'), {
          stderr:
            state === 'not-delivered' ? JSON.stringify({ error: { code: 'agent_blocked' } }) : '',
        });
      }

      return '{}';
    });

    const first = await submitGenericText(setup.records, setup.task, {
      id: 'reply-one',
      text: 'Scoped answer.',
      send,
    });
    const repeated = await submitGenericText(setup.records, setup.task, {
      id: 'reply-one',
      text: 'Scoped answer.',
      send,
    });

    expect(first?.observation?.state).toBe(state);
    expect(repeated).toEqual(first);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(
      submitGenericText(setup.records, setup.task, {
        id: 'reply-one',
        text: 'Changed answer.',
        send,
      }),
    ).rejects.toThrow('Conflicting');
  },
);

it('retains a crash between intent and observation as uncertain without a retry', async () => {
  const setup = fixture();
  publish(setup.records, 'submission-crash-intent.json', {
    taskId: setup.task.taskId,
    id: 'crash',
    text: 'Scoped answer.',
  });
  const send = vi.fn<() => Promise<string>>(async () => '{}');

  const receipt = await submitGenericText(setup.records, setup.task, {
    id: 'crash',
    text: 'Scoped answer.',
    send,
  });

  expect(receipt?.observation).toBeUndefined();
  expect(receipt?.retry).toContain('uncertain delivery');
  expect(send).not.toHaveBeenCalled();
});

it('refuses a saved submission intent belonging to another task', () => {
  const setup = fixture();
  publish(setup.records, 'submission-reply-intent.json', {
    taskId: 'another-task',
    id: 'reply',
    text: 'Unrelated answer.',
  });

  expect(() => readGenericSubmission(setup.records, setup.task.taskId, 'reply')).toThrow(
    'Invalid native submission intent',
  );
});
