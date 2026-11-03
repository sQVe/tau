import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Value } from 'typebox/value';
import { expect, it, onTestFinished, vi } from 'vitest';

import type { ExecCall } from '../../../tests/execFake.js';
import type { Exec } from '../../command.js';
import type { Connect } from '../../hc/connect.js';
import { saveCollectedRecord } from './collectedRecord.js';
import { comment, fixture, reviewAddress, stagingOf } from './fixtures/reviewFixture.js';
import { readReview } from './stage.js';
import { createDraftReviewTool } from './tool.js';
import type { DraftReviewRuntime } from './tool.js';

const saveFailure = vi.hoisted(() => ({
  active: false,
  abortSignal: undefined as AbortController | undefined,
  writes: 0,
  throwOnSave: true,
}));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    writeFile: async (...parameters: Parameters<typeof actual.writeFile>) => {
      const [target] = parameters;

      if (saveFailure.active && typeof target === 'string' && target.includes('.review.json.')) {
        saveFailure.writes += 1;

        if (saveFailure.writes > 2) {
          saveFailure.abortSignal?.abort();

          if (saveFailure.throwOnSave) {
            throw new Error('record save refused');
          }
        }
      }

      return actual.writeFile(...parameters);
    },
  };
});

const refusalFixtures = join(import.meta.dirname, 'fixtures', 'review');

const runtimeWithoutCalls = (): DraftReviewRuntime => ({
  exec: vi.fn<Exec>(),
  connect: vi.fn<Connect>(),
});

const commandCalls = (calls: ExecCall[], command: string, action: string) =>
  calls.filter((call) => call.command === command && call.commandArguments[0] === action);

it('prints the command outside a manager terminal, then collects only comments on reviewed files and changed files', async () => {
  const context = await fixture();
  const { run, setSession, deleted, records, real, data } = context;
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md', '.tau/slices/b.md'] });
  const manual = opened.details;

  if (manual.status !== 'manual') {
    throw new Error(`Expected a manual review, got ${manual.status}`);
  }

  const staging = stagingOf(manual.command);

  expect(manual.command).toMatch(/^tuicr --file '/);
  expect(await readFile(join(staging, '01-slices/1-a.md'), 'utf8')).toBe('one\ntwo\n');
  expect(context.hc.calls).toEqual([]);

  await writeFile(join(staging, '01-slices/1-a.md'), 'one\nTWO\n');

  await setSession([
    comment('on-a', '01-slices/1-a.md'),
    comment('on-c', 'tickets/c.md'),
    comment('session-level', null),
  ]);

  const collected = await run({ action: 'collect', directory: manual.directory });

  expect(collected.details).toEqual({
    status: 'reviewed',
    comments: [
      {
        path: real('slices/a.md'),
        startLine: 2,
        endLine: 3,
        type: 'issue',
        content: 'on-a',
      },
    ],
    edits: [
      {
        path: real('slices/a.md'),
        diff: '--- a/slices/a.md\n+++ b/slices/a.md\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n',
        status: 'applied',
      },
    ],
  });

  expect(await deleted()).toEqual(['on-a']);
  expect((await readFile(join(data, 'repos.log'), 'utf8')).trim()).toBe(staging);
  expect(await readFile(real('slices/a.md'), 'utf8')).toBe('one\nTWO\n');
  expect(await readFile(real('slices/b.md'), 'utf8')).toBe('bee\n');
  expect(await records()).toEqual([]);
  expect(context.hc.calls).toEqual([]);
  expect(existsSync(staging)).toBe(false);
});

it('reports a conflict and writes nothing when the real file changed during the review', async () => {
  const { run, setSession, real } = await fixture();
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] });
  const manual = opened.details;

  if (manual.status !== 'manual') {
    throw new Error('Expected a manual review.');
  }

  await writeFile(join(stagingOf(manual.command), '01-slices/1-a.md'), 'user\n');
  await writeFile(real('slices/a.md'), 'agent\n');
  await setSession([]);

  const collected = await run({ action: 'collect', directory: manual.directory });

  expect(collected.details).toMatchObject({
    status: 'reviewed',
    comments: [],
    edits: [{ path: real('slices/a.md'), status: 'conflict' }],
  });

  expect(await readFile(real('slices/a.md'), 'utf8')).toBe('agent\n');
});

it('returns no comments and no edits when tuicr has no session or no comments', async () => {
  const { run, setSession, deleted } = await fixture();
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] });
  const manual = opened.details;

  if (manual.status !== 'manual') {
    throw new Error('Expected a manual review.');
  }

  const withoutSession = await run({ action: 'collect', directory: manual.directory });

  expect(withoutSession.details).toEqual({ status: 'reviewed', comments: [], edits: [] });

  const second = await run({ action: 'open', paths: ['.tau/slices/a.md'] });

  await setSession([]);

  const withoutComments = await run({
    action: 'collect',
    directory: (second.details as { directory: string }).directory,
  });

  expect(withoutComments.details).toEqual({ status: 'reviewed', comments: [], edits: [] });
  expect(await deleted()).toEqual([]);
});

it.each([
  { name: 'a session list that is not JSON', sessions: 'oops', comments: '[]', output: 'oops' },
  {
    name: 'a session list of the wrong shape',
    sessions: '{"path":"x"}',
    comments: '[]',
    output: '{"path":"x"}',
  },
  {
    name: 'comments that are not JSON',
    sessions: undefined,
    comments: 'not json',
    output: 'not json',
  },
  {
    name: 'comments of the wrong shape',
    sessions: undefined,
    comments: JSON.stringify([{ id: 1 }]),
    output: '[{"id":1}]',
  },
])('fails and deletes nothing on $name', async ({ sessions, comments, output }) => {
  const { run, setSession, deleted, data, records } = await fixture();
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] });
  const manual = opened.details;

  if (manual.status !== 'manual') {
    throw new Error('Expected a manual review.');
  }

  await setSession(comments);

  if (sessions !== undefined) {
    await writeFile(join(data, 'sessions.txt'), sessions);
  }

  await expect(run({ action: 'collect', directory: manual.directory })).rejects.toThrow(output);
  expect(await deleted()).toEqual([]);
  expect(await records()).toHaveLength(1);
});

it('refuses paths that are not files inside .tau, one reason each', async () => {
  const { run, repository, records } = await fixture();
  await writeFile(join(repository, 'outside.md'), 'x');

  await expect(run({ action: 'open', paths: [] })).rejects.toThrow('at least one path');
  await expect(run({ action: 'open', paths: ['outside.md'] })).rejects.toThrow('outside');

  await expect(run({ action: 'open', paths: ['.tau/missing.md'] })).rejects.toThrow(
    'does not exist',
  );

  await expect(run({ action: 'open', paths: ['.tau/slices'] })).rejects.toThrow('not a file');

  await expect(run({ action: 'collect', directory: '.tau/slices' })).rejects.toThrow(
    'The draft_review directory must be in .tau/draft-review',
  );

  await expect(run({ action: 'collect' })).rejects.toThrow('needs a directory');
  await expect(records()).rejects.toThrow(/ENOENT/);
});

it('reports a conflict and keeps the agent content when the real file changes during collect', async () => {
  const { run, setSession, data, real } = await fixture();
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] });
  const manual = opened.details;

  if (manual.status !== 'manual') {
    throw new Error('Expected a manual review.');
  }

  await writeFile(join(stagingOf(manual.command), '01-slices/1-a.md'), 'user\n');
  await setSession([comment('on-a', '01-slices/1-a.md')]);

  await writeFile(
    join(data, 'mutate.json'),
    JSON.stringify({ path: real('slices/a.md'), content: 'agent\n' }),
  );

  const collected = await run({ action: 'collect', directory: manual.directory });

  expect(collected.details).toMatchObject({
    edits: [{ path: real('slices/a.md'), status: 'conflict' }],
  });

  expect(await readFile(real('slices/a.md'), 'utf8')).toBe('agent\n');
});

it('returns every comment on a retry after a delete failed partway and deletes only the rest', async () => {
  const { run, setSession, deleted, data, real } = await fixture();
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] });
  const manual = opened.details;

  if (manual.status !== 'manual') {
    throw new Error('Expected a manual review.');
  }

  await writeFile(join(stagingOf(manual.command), '01-slices/1-a.md'), 'user\n');
  await setSession([comment('one', '01-slices/1-a.md'), comment('two', '01-slices/1-a.md')]);
  await writeFile(join(data, 'fail.txt'), 'two');

  await expect(run({ action: 'collect', directory: manual.directory })).rejects.toThrow(
    'Could not delete tuicr comment two',
  );

  expect(await deleted()).toEqual(['one']);
  expect(await readFile(real('slices/a.md'), 'utf8')).toBe('one\ntwo\n');

  // The session now holds only the comment that remains.
  await setSession([comment('two', '01-slices/1-a.md')]);
  await rm(join(data, 'fail.txt'));

  const retried = await run({ action: 'collect', directory: manual.directory });

  expect(retried.details).toMatchObject({
    status: 'reviewed',
    comments: [{ content: 'one' }, { content: 'two' }],
    edits: [{ path: real('slices/a.md'), status: 'applied' }],
  });

  expect(await deleted()).toEqual(['one', 'two']);
  expect(await readFile(real('slices/a.md'), 'utf8')).toBe('user\n');
});

it('gives the model the result as text content', async () => {
  const { run, setSession } = await fixture();
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] });

  expect(opened.content).toHaveLength(1);
  expect(opened.content[0]).toMatchObject({ type: 'text' });
  expect(JSON.parse((opened.content[0] as { text: string }).text)).toEqual(opened.details);

  const manual = opened.details;

  if (manual.status !== 'manual') {
    throw new Error('Expected a manual review.');
  }

  await setSession([comment('on-a', '01-slices/1-a.md')]);

  const collected = await run({ action: 'collect', directory: manual.directory });

  expect(JSON.parse((collected.content[0] as { text: string }).text)).toEqual(collected.details);
  expect(collected.details).toMatchObject({ comments: [{ content: 'on-a' }] });
});

it('refuses an open call that has no paths', async () => {
  const { run } = await fixture();

  await expect(run({ action: 'open' })).rejects.toThrow('at least one path');
});

it('refuses the removed review action', () => {
  const { parameters } = createDraftReviewTool(runtimeWithoutCalls());

  expect(Value.Check(parameters, { action: 'review', paths: ['.tau/slices/a.md'] })).toBe(false);
});

it.each([
  { call: { action: 'open' }, valid: true },
  { call: { action: 'collect' }, valid: true },
  { call: { action: 'open', paths: ['.tau/a.md'] }, valid: true },
  { call: { action: 'review' }, valid: false },
  { call: { action: 'review', paths: ['.tau/a.md'] }, valid: false },
  { call: { action: 'collect', directory: '.tau/draft-review/review-1' }, valid: true },
  { call: { action: 'other' }, valid: false },
  { call: {}, valid: false },
  { call: { action: 'open', paths: [''] }, valid: false },
  { call: { action: 'collect', directory: '' }, valid: false },
])('checks the arguments $call: valid is $valid', ({ call, valid }) => {
  const { parameters } = createDraftReviewTool(runtimeWithoutCalls());

  expect(Value.Check(parameters, call)).toBe(valid);
});

const manualReview = async (paths = ['.tau/slices/a.md']) => {
  const context = await fixture();
  const opened = await context.run({ action: 'open', paths });

  if (opened.details.status !== 'manual') {
    throw new Error('Expected a manual review.');
  }

  return { ...context, manual: opened.details, staging: stagingOf(opened.details.command) };
};

it('collects without edits when the user deleted the staging directory', async () => {
  const { run, manual, staging, real, records } = await manualReview();

  await rm(staging, { recursive: true });

  const collected = await run({ action: 'collect', directory: manual.directory });

  expect(collected.details).toEqual({ status: 'reviewed', comments: [], edits: [] });
  expect(await readFile(real('slices/a.md'), 'utf8')).toBe('one\ntwo\n');
  expect(await records()).toEqual([]);
});

it('collects without an edit for a file the user deleted from staging', async () => {
  const { run, manual, staging, real } = await manualReview([
    '.tau/slices/a.md',
    '.tau/slices/b.md',
  ]);

  await rm(join(staging, '01-slices/1-a.md'));
  await writeFile(join(staging, '01-slices/2-b.md'), 'user\n');

  const collected = await run({ action: 'collect', directory: manual.directory });

  expect(collected.details).toMatchObject({ edits: [{ path: real('slices/b.md') }] });
  expect(await readFile(real('slices/a.md'), 'utf8')).toBe('one\ntwo\n');
});

it('fails when a staged file cannot be read, deleting nothing and keeping the review', async () => {
  const { run, setSession, deleted, manual, staging, real, records } = await manualReview([
    '.tau/slices/a.md',
    '.tau/slices/b.md',
  ]);

  await rm(join(staging, '01-slices/1-a.md'));
  await mkdir(join(staging, '01-slices/1-a.md'));
  await writeFile(join(staging, '01-slices/2-b.md'), 'user\n');
  await setSession([comment('on-b', '01-slices/2-b.md')]);

  await expect(run({ action: 'collect', directory: manual.directory })).rejects.toThrow(/EISDIR/);

  expect(await deleted()).toEqual([]);
  expect(await readFile(real('slices/a.md'), 'utf8')).toBe('one\ntwo\n');
  expect(await readFile(real('slices/b.md'), 'utf8')).toBe('bee\n');
  expect(existsSync(staging)).toBe(true);
  expect(await records()).toHaveLength(1);
});

it.each(['applied', 'conflict'] as const)(
  'does not decide again an edit saved as %s',
  async (status) => {
    const { run, manual, real } = await manualReview();

    await saveCollectedRecord(manual.directory, {
      comments: [],
      edits: [{ path: 'slices/a.md', diff: 'saved diff', staged: 'user\n', status }],
    });

    const collected = await run({ action: 'collect', directory: manual.directory });

    expect(collected.details).toMatchObject({ edits: [{ diff: 'saved diff', status }] });
    expect(await readFile(real('slices/a.md'), 'utf8')).toBe('one\ntwo\n');
  },
);

it('keeps the plan from the first try when the first delete fails', async () => {
  const { run, setSession, data, manual } = await manualReview();

  await setSession([comment('one', '01-slices/1-a.md'), comment('two', '01-slices/1-a.md')]);
  await writeFile(join(data, 'fail.txt'), 'one');

  const failed = run({ action: 'collect', directory: manual.directory });

  await expect(failed).rejects.toThrow(/deleted before it: none\./);

  await setSession([]);
  await rm(join(data, 'fail.txt'));

  const retried = await run({ action: 'collect', directory: manual.directory });

  expect(retried.details).toMatchObject({ comments: [{ content: 'one' }, { content: 'two' }] });
});

it('names the comments deleted before a failed delete', async () => {
  const { run, setSession, data, manual } = await manualReview();

  await setSession([
    comment('one', '01-slices/1-a.md'),
    comment('two', '01-slices/1-a.md'),
    comment('three', '01-slices/1-a.md'),
  ]);

  await writeFile(join(data, 'fail.txt'), 'three');

  await expect(run({ action: 'collect', directory: manual.directory })).rejects.toThrow(
    /deleted before it: one, two\./,
  );
});

it('opens tuicr in a manager tab with the space label and --bg, then saves a version 4 record', async () => {
  const context = await fixture({ space: 'space-a' });
  const opened = await context.run({ action: 'open', paths: ['.tau/slices/a.md'] });
  const details = opened.details;

  if (details.status !== 'opened') {
    throw new Error(`Expected an opened review, got ${details.status}`);
  }

  const runCall = commandCalls(context.hc.calls, 'hc', 'run')[0]?.commandArguments ?? [];
  const name = runCall[runCall.indexOf('--name') + 1];
  const { stagingDirectory } = await readReview(context.repository, details.directory);

  expect(runCall).toContain('--bg');
  expect(runCall[runCall.indexOf('--label') + 1]).toBe('herdr.space=space-a');
  expect(name).toMatch(/^draft-review-[0-9a-f]{8}$/);
  expect(runCall).toContain('tuicr');
  expect(runCall.at(-1)).toBe(stagingDirectory);

  const manifest = JSON.parse(await readFile(join(details.directory, 'review.json'), 'utf8')) as {
    version: number;
    terminal: unknown;
  };

  expect(manifest.version).toBe(4);
  expect(details.terminal).toBe('review-1');
  expect(manifest.terminal).toEqual({ state: 'open', address: details.terminal });

  expect((await readReview(context.repository, details.directory)).terminal).toEqual({
    state: 'open',
    address: details.terminal,
  });
});

it('returns comments after an hc wait reports the terminal ended', async () => {
  const context = await fixture({ space: 'space-a' });
  const opened = await context.run({ action: 'open', paths: ['.tau/slices/a.md'] });
  const directory = (opened.details as { directory: string }).directory;

  await context.setSession([comment('on-a', '01-slices/1-a.md')]);

  const collected = await context.run({ action: 'collect', directory });

  expect(collected.details).toMatchObject({
    status: 'reviewed',
    comments: [{ path: context.real('slices/a.md'), content: 'on-a' }],
  });

  const waitIndex = context.calls.findIndex(
    (call) => call.command === 'hc' && call.commandArguments[0] === 'wait',
  );

  const listIndex = context.calls.findIndex(
    (call) => call.command === 'tuicr' && call.commandArguments[0] === 'review',
  );

  expect(waitIndex).toBeGreaterThanOrEqual(0);
  expect(listIndex).toBeGreaterThan(waitIndex);
  expect(await context.deleted()).toEqual(['on-a']);
});

it('reads no comment and deletes none when hc wait keeps reporting a message', async () => {
  const context = await fixture({ space: 'space-a' });
  const opened = await context.run({ action: 'open', paths: ['.tau/slices/a.md'] });
  const directory = (opened.details as { directory: string }).directory;

  await context.setSession([comment('on-a', '01-slices/1-a.md')]);
  context.setWait({ ended: false, reason: 'message' });

  await expect(context.run({ action: 'collect', directory })).rejects.toThrow(directory);

  expect(commandCalls(context.calls, 'tuicr', 'review')).toEqual([]);
  expect(await context.deleted()).toEqual([]);
  expect(await context.records()).toHaveLength(1);
});

it('ends only the address it started when saving the record fails, then throws', async () => {
  const context = await fixture({ space: 'space-a' });
  saveFailure.writes = 0;
  saveFailure.active = true;
  saveFailure.throwOnSave = true;
  saveFailure.abortSignal = undefined;

  onTestFinished(() => {
    saveFailure.active = false;
    saveFailure.throwOnSave = true;
  });

  await expect(context.run({ action: 'open', paths: ['.tau/slices/a.md'] })).rejects.toThrow(
    'record save refused',
  );

  const kills = commandCalls(context.hc.calls, 'hc', 'kill');

  expect(kills).toHaveLength(1);
  expect(kills[0]?.commandArguments.at(-1)).toBe('review-1');
});

it.each(['version-1.json', 'version-2.json', 'version-3.json'])(
  'refuses to collect the %s record, deletes no comment, and keeps the record and staging',
  async (name) => {
    const context = await fixture();
    const opened = await context.run({ action: 'open', paths: ['.tau/slices/a.md'] });
    const manual = opened.details as { directory: string; command: string };
    const staging = stagingOf(manual.command);

    await writeFile(
      join(manual.directory, 'review.json'),
      await readFile(join(refusalFixtures, name), 'utf8'),
    );

    await context.setSession([comment('on-a', '01-slices/1-a.md')]);

    await expect(context.run({ action: 'collect', directory: manual.directory })).rejects.toThrow(
      /saved by an older Tau/,
    );

    expect(commandCalls(context.calls, 'tuicr', 'review')).toEqual([]);
    expect(await context.deleted()).toEqual([]);
    expect(existsSync(manual.directory)).toBe(true);
    expect(existsSync(staging)).toBe(true);
  },
);

it('removes the record and returns cancelled when open is aborted', async () => {
  const context = await fixture({ space: 'space-a' });
  const controller = new AbortController();

  controller.abort();

  const opened = await context.run(
    { action: 'open', paths: ['.tau/slices/a.md'] },
    controller.signal,
  );

  expect(opened.details).toEqual({ status: 'cancelled', comments: [], edits: [] });
  expect(await context.records()).toEqual([]);
});

it('removes the record and returns cancelled when a manual open is aborted', async () => {
  const context = await fixture();
  const controller = new AbortController();

  controller.abort();

  const opened = await context.run(
    { action: 'open', paths: ['.tau/slices/a.md'] },
    controller.signal,
  );

  expect(opened.details).toEqual({ status: 'cancelled', comments: [], edits: [] });
  expect(await context.records()).toEqual([]);
  expect(await context.staging()).toEqual([]);
});

it('removes the record and returns cancelled when the save succeeds after the abort', async () => {
  const context = await fixture({ space: 'space-a' });
  const controller = new AbortController();

  saveFailure.writes = 0;
  saveFailure.active = true;
  saveFailure.throwOnSave = false;
  saveFailure.abortSignal = controller;

  onTestFinished(() => {
    saveFailure.active = false;
    saveFailure.throwOnSave = true;
    saveFailure.abortSignal = undefined;
  });

  const opened = await context.run(
    { action: 'open', paths: ['.tau/slices/a.md'] },
    controller.signal,
  );

  expect(opened.details).toEqual({ status: 'cancelled', comments: [], edits: [] });
  expect(await context.records()).toEqual([]);
  expect(await context.staging()).toEqual([]);
  expect(commandCalls(context.hc.calls, 'hc', 'kill')).toHaveLength(1);
});

it('kills the started address and removes the record when open is aborted while hc run is pending', async () => {
  const context = await fixture({ space: 'space-a' });
  const controller = new AbortController();
  const gate = context.holdHcRun();

  const opened = context.run({ action: 'open', paths: ['.tau/slices/a.md'] }, controller.signal);

  await gate.started;
  controller.abort();
  gate.release();

  const result = await opened;

  const killed = commandCalls(context.hc.calls, 'hc', 'kill').map(({ commandArguments }) =>
    commandArguments.at(-1),
  );

  expect(result.details).toEqual({ status: 'cancelled', comments: [], edits: [] });
  expect(killed).toEqual([reviewAddress]);
  expect(await context.records()).toEqual([]);
  expect(await context.staging()).toEqual([]);
});

it('fails and keeps the starting record when hc run stalls past the launch limit', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const context = await fixture({ space: 'space-a' });
  const gate = context.holdHcRun({ ignoresAbort: true });

  const failure = context.run({ action: 'open', paths: ['.tau/slices/a.md'] }).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );

  await gate.started;
  await vi.advanceTimersByTimeAsync(15_000);

  const error = await failure;

  if (error === undefined) {
    throw new Error('Expected the open to fail.');
  }

  const [name] = await context.records();
  const directory = join(context.repository, '.tau/draft-review', name ?? '');

  expect(error.message).toContain(directory);

  const manifest = JSON.parse(await readFile(join(directory, 'review.json'), 'utf8')) as {
    terminal: unknown;
  };

  expect(manifest.terminal).toEqual({ state: 'starting' });
});

it('names the retained record and keeps it starting when the caller aborts before the launch limit', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const context = await fixture({ space: 'space-a' });
  const controller = new AbortController();
  const gate = context.holdHcRun();

  const failure = context
    .run({ action: 'open', paths: ['.tau/slices/a.md'] }, controller.signal)
    .then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );

  await gate.started;
  controller.abort();
  await vi.advanceTimersByTimeAsync(15_000);

  const error = await failure;

  if (error === undefined) {
    throw new Error('Expected the open to fail.');
  }

  const [name] = await context.records();
  const directory = join(context.repository, '.tau/draft-review', name ?? '');

  expect(error.message).toContain(directory);
  expect(commandCalls(context.hc.calls, 'hc', 'kill')).toEqual([]);
  expect(await context.records()).toHaveLength(1);

  const manifest = JSON.parse(await readFile(join(directory, 'review.json'), 'utf8')) as {
    terminal: unknown;
  };

  expect(manifest.terminal).toEqual({ state: 'starting' });
});

it('leaves no pending timer when hc run returns before the launch limit', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const context = await fixture({ space: 'space-a' });

  await context.run({ action: 'open', paths: ['.tau/slices/a.md'] });

  expect(vi.getTimerCount()).toBe(0);
});

it('keeps the starting record and names the terminal when saving the address and hc kill both fail', async () => {
  const context = await fixture({ space: 'space-a' });

  context.hc.fail('kill', 'kill refused', 1);
  saveFailure.writes = 0;
  saveFailure.active = true;
  saveFailure.throwOnSave = true;
  saveFailure.abortSignal = undefined;

  onTestFinished(() => {
    saveFailure.active = false;
  });

  const failure = await context.run({ action: 'open', paths: ['.tau/slices/a.md'] }).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );

  if (failure === undefined) {
    throw new Error('Expected the open to fail.');
  }

  expect(failure.message).toContain(join(context.repository, '.tau/draft-review/review-'));
  expect(failure.message).toContain('review-1');
  expect(failure.message).toContain('kill refused');

  const [name] = await context.records();

  const directory = join(context.repository, '.tau/draft-review', name ?? '');

  const manifest = JSON.parse(await readFile(join(directory, 'review.json'), 'utf8')) as {
    terminal: unknown;
  };

  expect(manifest.terminal).toEqual({ state: 'starting' });

  await context.setSession([comment('on-a', '01-slices/1-a.md')]);

  await expect(context.run({ action: 'collect', directory })).rejects.toThrow(directory);
  expect(commandCalls(context.calls, 'tuicr', 'review')).toEqual([]);
  expect(await context.deleted()).toEqual([]);
  expect(await context.records()).toHaveLength(1);
});

it('keeps the review and deletes nothing when a collect is aborted while hc wait is pending', async () => {
  const context = await fixture({ space: 'space-a' });
  const opened = await context.run({ action: 'open', paths: ['.tau/slices/a.md'] });
  const directory = (opened.details as { directory: string }).directory;

  await context.setSession([comment('on-a', '01-slices/1-a.md')]);

  const gate = context.holdHcWait();
  const controller = new AbortController();

  const failure = context.run({ action: 'collect', directory }, controller.signal).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );

  await gate.started;
  controller.abort();

  const error = await failure;

  expect(error?.message).toContain(directory);
  expect(commandCalls(context.calls, 'tuicr', 'review')).toEqual([]);
  expect(await context.deleted()).toEqual([]);
  expect(await context.records()).toHaveLength(1);
});

it('propagates a cleanup failure once when the aborted open cleanup fails', async () => {
  const context = await fixture({ space: 'space-a' });
  const controller = new AbortController();

  context.hc.fail('kill', 'kill refused', 1);
  saveFailure.writes = 0;
  saveFailure.active = true;
  saveFailure.throwOnSave = false;
  saveFailure.abortSignal = controller;

  onTestFinished(() => {
    saveFailure.active = false;
    saveFailure.throwOnSave = true;
    saveFailure.abortSignal = undefined;
  });

  const failure = context.run({ action: 'open', paths: ['.tau/slices/a.md'] }, controller.signal);

  await expect(failure).rejects.toThrow(join(context.repository, '.tau/draft-review/review-'));
  await expect(failure).rejects.toThrow(/and terminal review-1/);
  await expect(failure).rejects.toThrow(/kill refused/);
  expect(commandCalls(context.hc.calls, 'hc', 'kill')).toHaveLength(1);
  expect(await context.records()).toHaveLength(1);
});

it('saves the starting state before hc run', async () => {
  const context = await fixture({ space: 'space-a' });

  context.hc.fail('run', 'run refused', 1);

  await expect(context.run({ action: 'open', paths: ['.tau/slices/a.md'] })).rejects.toThrow(
    /run refused/,
  );

  const [name] = await context.records();

  const manifest = JSON.parse(
    await readFile(
      join(context.repository, '.tau/draft-review', name ?? '', 'review.json'),
      'utf8',
    ),
  ) as { terminal: unknown };

  expect(manifest.terminal).toEqual({ state: 'starting' });
});

it('refuses to collect a record left in the starting state and keeps it', async () => {
  const context = await fixture({ space: 'space-a' });

  context.hc.fail('run', 'run refused', 1);

  await expect(context.run({ action: 'open', paths: ['.tau/slices/a.md'] })).rejects.toThrow(
    /run refused/,
  );

  const [name] = await context.records();
  const directory = join(context.repository, '.tau/draft-review', name ?? '');

  await context.setSession([comment('on-a', '01-slices/1-a.md')]);

  await expect(context.run({ action: 'collect', directory })).rejects.toThrow(directory);
  expect(commandCalls(context.calls, 'tuicr', 'review')).toEqual([]);
  expect(await context.deleted()).toEqual([]);
  expect(await context.records()).toHaveLength(1);
});

it('names the record and ends nothing when hc run fails before a terminal starts', async () => {
  const context = await fixture({ space: 'space-a' });

  context.hc.fail('run', 'run refused', 1);

  const failure = context.run({ action: 'open', paths: ['.tau/slices/a.md'] });

  await expect(failure).rejects.toThrow(join(context.repository, '.tau/draft-review/review-'));
  expect(commandCalls(context.hc.calls, 'hc', 'kill')).toEqual([]);
  expect(await context.records()).toHaveLength(1);
});
