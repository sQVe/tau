import { getEventListeners } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Value } from 'typebox/value';
import { expect, it, onTestFinished, vi } from 'vitest';

import { herdrFake } from '../../../tests/herdrFake.js';
import type { Exec } from '../../command.js';
import { saveCollectedRecord } from './collectedRecord.js';
import { agentPane, comment, fixture, stagingOf } from './fixtures/reviewFixture.js';
import { readReview } from './stage.js';
import { createDraftReviewTool } from './tool.js';

const placementFailure = vi.hoisted(() => ({ active: false }));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    writeFile: async (...parameters: Parameters<typeof actual.writeFile>) => {
      const [target] = parameters;

      if (
        placementFailure.active &&
        typeof target === 'string' &&
        target.includes('.review.json.')
      ) {
        throw new Error('placement write refused');
      }

      return actual.writeFile(...parameters);
    },
  };
});

it('prints the command outside herdr, then collects only comments on reviewed files and changed files', async () => {
  const { run, setSession, deleted, records, real, herdrCalls, data } = await fixture();
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md', '.tau/slices/b.md'] });
  const manual = opened.details;

  if (manual.status !== 'manual') {
    throw new Error(`Expected a manual review, got ${manual.status}`);
  }

  const staging = stagingOf(manual.command);

  expect(manual.command).toMatch(/^tuicr --file '/);
  expect(await readFile(join(staging, '01-slices/1-a.md'), 'utf8')).toBe('one\ntwo\n');
  expect(herdrCalls).toEqual([]);

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

const processInfo = (...pids: number[]) =>
  JSON.stringify({
    result: { process_info: { foreground_processes: pids.map((pid) => ({ pid })) } },
  });

const socketClosed = () => new Error('herdr failed: socket closed');

// The tuicr process the fake herdr started for the open review.
const tuicr = (herdr: ReturnType<typeof herdrFake>) => herdr.workers().at(-1)!;

const reviewTab = (herdr: ReturnType<typeof herdrFake>) => herdr.layout.panes.at(-1)!.tab_id;

const steps = (calls: string[][]) => calls.map(([group, action]) => `${group} ${action}`);

it('names the record directory when another herdr call fails', async () => {
  const herdr = herdrFake();
  herdr.failCall('pane run', socketClosed());

  const { run, repository } = await fixture(herdr);

  await expect(run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane)).rejects.toThrow(
    join(repository, '.tau/draft-review/review-'),
  );
});

it('ignores a pane that is already gone on close but names the record when close fails', async () => {
  const herdr = herdrFake();
  herdr.failCall('pane run', socketClosed());

  const { run, repository } = await fixture(herdr);

  herdr.failCall('pane close', new Error('herdr failed: {"error":{"code":"pane_not_found"}}'));

  await expect(run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane)).rejects.toThrow(
    'socket closed',
  );

  herdr.failCall('pane close', socketClosed());

  await expect(run({ action: 'open', paths: ['.tau/slices/b.md'] }, agentPane)).rejects.toThrow(
    join(repository, '.tau/draft-review/review-'),
  );
});

it('opens a right split when the agent pane is 164 columns wide', async () => {
  const herdr = herdrFake(164);
  const { run } = await fixture(herdr);

  await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);

  expect(steps(herdr.calls)).toContain('pane split');
  expect(herdr.calls.some(([group]) => group === 'tab')).toBe(false);
});

it.each([
  { width: 163, zoomed: false },
  { width: 200, zoomed: true },
])(
  'opens a tab in the agent workspace for a $width column pane, zoomed $zoomed',
  async ({ width, zoomed }) => {
    const herdr = herdrFake(width);

    if (zoomed) {
      herdr.zoom();
    }

    const { run, herdrCalls } = await fixture(herdr);

    await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);

    const create = herdrCalls.find(([group, action]) => group === 'tab' && action === 'create');

    expect(create).not.toContain('--focus');
    expect(create?.[create.indexOf('--workspace') + 1]).toBe(herdr.layout.parent.workspace_id);
    expect(steps(herdrCalls)).not.toContain('pane split');
    expect(herdrCalls.find(([, action]) => action === 'run')?.[2]).toBe(tuicr(herdr).paneId);
  },
);

it('collects when the user closes the review pane and the tab is already gone', async () => {
  const herdr = herdrFake(100);
  const { run, herdrCalls } = await fixture(herdr);

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
  herdr.loseTabOnClose(reviewTab(herdr));

  const outcome = await run({
    action: 'collect',
    directory: (opened.details as { directory: string }).directory,
  });

  expect(outcome.details).toMatchObject({ status: 'reviewed' });
  expect(herdrCalls.at(-1)).toEqual(['tab', 'focus', herdr.layout.parent.tab_id]);
});

it('fails with the herdr error and opens nothing when the pane layout cannot be read', async () => {
  const herdr = herdrFake();
  herdr.failCall('pane layout', socketClosed());

  const { run, herdrCalls } = await fixture(herdr);

  await expect(run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane)).rejects.toThrow(
    'herdr failed: socket closed',
  );

  expect(herdrCalls.map(([, action]) => action)).toEqual(['layout']);
});

const abortDuringOpen = async (step: string) => {
  const controller = new AbortController();
  const herdr = herdrFake(100);
  herdr.hangCall(step);

  const { run, setSession, deleted, records } = await fixture(herdr);

  await setSession([comment('on-a', '01-slices/1-a.md')]);

  const opening = run(
    { action: 'open', paths: ['.tau/slices/a.md'] },
    agentPane,
    controller.signal,
  );

  await vi.waitFor(() => {
    expect(steps(herdr.calls)).toContain(step);
  });

  controller.abort();

  const outcome = await opening;

  return { details: outcome.details, deleted: await deleted(), records: await records() };
};

const cancelledWithNothingKept = {
  details: { status: 'cancelled', comments: [], edits: [] },
  deleted: [],
  records: [],
};

it('returns cancelled and keeps no record when aborted during pane layout', async () => {
  expect(await abortDuringOpen('pane layout')).toEqual(cancelledWithNothingKept);
});

it('returns cancelled and keeps no record when aborted during tab create', async () => {
  expect(await abortDuringOpen('tab create')).toEqual(cancelledWithNothingKept);
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
  const { parameters } = createDraftReviewTool({
    exec: vi.fn<Exec>(),
    herdrPaneId: () => undefined,
    isProcessRunning: () => false,
  });

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
  const { parameters } = createDraftReviewTool({
    exec: vi.fn<Exec>(),
    herdrPaneId: () => undefined,
    isProcessRunning: () => false,
  });

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

it.each([
  { agentWidth: 200, otherWidth: 50, placement: 'pane split' },
  { agentWidth: 50, otherWidth: 200, placement: 'tab create' },
])(
  'places the review by the agent pane width $agentWidth, not another pane',
  async ({ agentWidth, otherWidth, placement }) => {
    const herdr = herdrFake(agentWidth);
    herdr.addPane('other', otherWidth);

    const { run, herdrCalls } = await fixture(herdr);

    await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);

    expect(steps(herdrCalls)).toContain(placement);
  },
);

it('sends herdr the split arguments for a pane beside the agent', async () => {
  const { run, herdrCalls } = await fixture(herdrFake());

  await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);

  const staging = /--file '([^']+)'/.exec(
    herdrCalls.find(([, action]) => action === 'run')?.[3] ?? '',
  )?.[1];

  expect(herdrCalls.find(([, action]) => action === 'split')).toEqual([
    'pane',
    'split',
    '--pane',
    agentPane,
    '--direction',
    'right',
    '--cwd',
    staging,
  ]);
});

it('sends herdr the arguments for a review tab in the agent workspace', async () => {
  const herdr = herdrFake(100);
  const { run, herdrCalls } = await fixture(herdr);

  await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);

  const staging = /--file '([^']+)'/.exec(
    herdrCalls.find(([, action]) => action === 'run')?.[3] ?? '',
  )?.[1];

  expect(herdrCalls.find(([group, action]) => group === 'tab' && action === 'create')).toEqual([
    'tab',
    'create',
    '--workspace',
    herdr.layout.parent.workspace_id,
    '--cwd',
    staging,
    '--label',
    expect.any(String),
  ]);
});

it('reports a tab close failure other than a missing tab and keeps the agent tab unfocused', async () => {
  const herdr = herdrFake(100);
  herdr.failCall('tab close', socketClosed());

  const { run, herdrCalls } = await fixture(herdr);

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);

  await expect(
    run({ action: 'collect', directory: (opened.details as { directory: string }).directory }),
  ).rejects.toThrow('socket closed');

  expect(herdrCalls.some(([group, action]) => group === 'tab' && action === 'focus')).toBe(false);
});

const stagingFor = async (repository: string): Promise<string> => {
  const parent = join(repository, '.tau/draft-review');
  const [name] = await readdir(parent);
  const manifest = await readFile(join(parent, name ?? '', 'review.json'), 'utf8');

  return (JSON.parse(manifest) as { stagingDirectory: string }).stagingDirectory;
};

it('opens tuicr beside the agent without focus and returns at once', async () => {
  const herdr = herdrFake();
  const { run, herdrCalls, repository } = await fixture(herdr);

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
  const details = opened.details;

  if (details.status !== 'opened') {
    throw new Error(`Expected an opened review, got ${details.status}`);
  }

  const split = herdrCalls.find(([, action]) => action === 'split') ?? [];
  const staging = await stagingFor(repository);

  expect(details.directory).toContain(join(repository, '.tau/draft-review/review-'));
  expect(split).not.toContain('--focus');
  expect(steps(herdrCalls)).not.toContain('pane wait-output');

  expect(herdrCalls.find(([, action]) => action === 'run')).toEqual([
    'pane',
    'run',
    tuicr(herdr).paneId,
    `tuicr --file '${staging}'`,
  ]);

  expect((await readReview(repository, details.directory)).placement).toEqual({
    kind: 'split',
    terminalId: tuicr(herdr).terminalId,
  });
});

it('opens a tab without focus, with no tab focus call', async () => {
  const herdr = herdrFake(100);
  const { run, herdrCalls, repository } = await fixture(herdr);

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
  const create = herdrCalls.find(([group, action]) => group === 'tab' && action === 'create');

  expect(opened.details).toMatchObject({ status: 'opened' });
  expect(create).not.toContain('--focus');
  expect(steps(herdrCalls)).not.toContain('pane wait-output');
  expect(steps(herdrCalls)).not.toContain('tab focus');

  expect(herdrCalls.find(([, action]) => action === 'run')).toEqual([
    'pane',
    'run',
    tuicr(herdr).paneId,
    `tuicr --file '${await stagingFor(repository)}'`,
  ]);

  const directory = (opened.details as { directory: string }).directory;

  expect((await readReview(repository, directory)).placement).toEqual({
    kind: 'tab',
    terminalId: tuicr(herdr).terminalId,
    tabId: reviewTab(herdr),
    agentTabId: herdr.layout.parent.tab_id,
  });
});

it('returns the command outside herdr when open is called', async () => {
  const { run, herdrCalls } = await fixture();

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] });

  const details = opened.details;

  expect(details.status).toBe('manual');
  expect('command' in details && details.command).toMatch(/^tuicr --file /);
  expect(herdrCalls).toEqual([]);
});

it('removes the record and returns cancelled when open is cancelled', async () => {
  const controller = new AbortController();

  const herdr = herdrFake();
  herdr.hangCall('pane split');

  const { run, records } = await fixture(herdr);

  const opening = run(
    { action: 'open', paths: ['.tau/slices/a.md'] },
    agentPane,
    controller.signal,
  );

  await vi.waitFor(() => {
    expect(steps(herdr.calls)).toContain('pane split');
  });

  controller.abort();

  const opened = await opening;

  expect(opened.details).toEqual({ status: 'cancelled', comments: [], edits: [] });
  expect(await records()).toEqual([]);
});

it('closes the tuicr pane and waits for its process to exit before deleting a comment', async () => {
  const state: { running: boolean; checks: number; deletedWhileRunning: boolean } = {
    running: true,
    checks: 0,
    deletedWhileRunning: false,
  };

  const herdr = herdrFake();

  const context = await fixture(herdr, async (processId) => {
    state.checks += 1;
    state.deletedWhileRunning ||= state.running && (await context.deleted()).length > 0;

    if (state.checks >= 3) {
      state.running = false;
    }

    return processId === tuicr(herdr).processId && state.running;
  });

  const { run, setSession, deleted, herdrCalls } = context;
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
  const reviewPane = tuicr(herdr).paneId;
  await setSession([comment('on-a', '01-slices/1-a.md')]);

  const collected = await run({
    action: 'collect',
    directory: (opened.details as { directory: string }).directory,
  });

  expect(collected.details).toMatchObject({ status: 'reviewed', comments: [{ content: 'on-a' }] });
  expect(herdrCalls.at(-1)).toEqual(['pane', 'close', reviewPane]);
  expect(state.checks).toBe(3);
  expect(state.deletedWhileRunning).toBe(false);
  expect(await deleted()).toEqual(['on-a']);
});

it('fails naming the record when the tuicr process never exits, and deletes nothing', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const herdr = herdrFake();
  const checked = new Set<number>();

  // The next poll's timer exists by the time this immediate runs.
  const { run, setSession, deleted, records, repository } = await fixture(herdr, (processId) => {
    checked.add(processId);
    setImmediate(() => vi.advanceTimersByTime(100));

    return true;
  });

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
  const { terminalId, processId } = tuicr(herdr);

  // herdr may name only the foreground processes.
  herdr.holdReply(
    terminalId,
    'processInfo',
    JSON.stringify({ result: { process_info: { foreground_processes: [{ pid: processId }] } } }),
  );

  await setSession([comment('on-a', '01-slices/1-a.md')]);

  const directory = (opened.details as { directory: string }).directory;

  await expect(run({ action: 'collect', directory })).rejects.toThrow(directory);

  expect(await deleted()).toEqual([]);
  expect(await records()).toHaveLength(1);
  expect((await readReview(repository, directory)).recordDirectory).toBe(directory);
  expect([...checked]).toEqual([tuicr(herdr).processId]);
});

it('waits on the saved tuicr process when a retry finds the terminal gone, then deletes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const state = { running: true, checked: [] as number[] };
  const herdr = herdrFake();

  const context = await fixture(herdr, (processId) => {
    state.checked.push(processId);
    setImmediate(() => vi.advanceTimersByTime(100));

    return state.running;
  });

  const { run, setSession, deleted, records } = context;
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
  await setSession([comment('on-a', '01-slices/1-a.md')]);

  const directory = (opened.details as { directory: string }).directory;

  await expect(run({ action: 'collect', directory })).rejects.toThrow(directory);

  expect(await deleted()).toEqual([]);
  expect(await records()).toHaveLength(1);
  expect(tuicr(herdr).exited).toBe(true);

  state.checked.length = 0;

  await expect(run({ action: 'collect', directory })).rejects.toThrow(directory);

  expect(state.checked).toContain(tuicr(herdr).processId);
  expect(await deleted()).toEqual([]);
  expect(await records()).toHaveLength(1);

  state.running = false;

  const collected = await run({ action: 'collect', directory });

  expect(collected.details).toMatchObject({ status: 'reviewed', comments: [{ content: 'on-a' }] });
  expect(await deleted()).toEqual(['on-a']);
});

it('stops waiting on the saved tuicr process when the retry is cancelled', async () => {
  const state = { running: true };
  const herdr = herdrFake();
  const { run, setSession, deleted } = await fixture(herdr, () => state.running);
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
  await setSession([comment('on-a', '01-slices/1-a.md')]);

  const directory = (opened.details as { directory: string }).directory;
  const firstTry = new AbortController();

  firstTry.abort();

  await expect(run({ action: 'collect', directory }, undefined, firstTry.signal)).rejects.toThrow(
    directory,
  );

  expect(tuicr(herdr).exited).toBe(true);

  const retry = new AbortController();

  setTimeout(() => {
    retry.abort();
  }, 20);

  await expect(run({ action: 'collect', directory }, undefined, retry.signal)).rejects.toThrow(
    directory,
  );

  expect(await deleted()).toEqual([]);
});

it('polls the tuicr process 100 times, then leaves no timer or abort listener behind', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const state = { checks: 0 };
  const controller = new AbortController();

  const { run } = await fixture(herdrFake(), () => {
    state.checks += 1;
    setImmediate(() => vi.advanceTimersByTime(100));

    return true;
  });

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
  const directory = (opened.details as { directory: string }).directory;

  await expect(run({ action: 'collect', directory }, agentPane, controller.signal)).rejects.toThrow(
    directory,
  );

  expect(state.checks).toBe(100);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('stops waiting for tuicr at once when the call is aborted, leaving no timer behind', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const controller = new AbortController();
  const state = { checks: 0 };

  const { run, setSession, deleted } = await fixture(herdrFake(), () => {
    state.checks += 1;

    return true;
  });

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
  await setSession([comment('on-a', '01-slices/1-a.md')]);

  const directory = (opened.details as { directory: string }).directory;
  const collecting = run({ action: 'collect', directory }, agentPane, controller.signal);

  const failure = collecting.then(
    () => '',
    (error: unknown) => (error instanceof Error ? error.message : ''),
  );

  await vi.waitFor(() => {
    expect(vi.getTimerCount()).toBe(1);
  });

  controller.abort();

  expect(await failure).toContain(directory);

  expect(state.checks).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  expect(await deleted()).toEqual([]);
});

it.each([
  { label: 'split', width: 200, close: 'pane close' },
  { label: 'tab', width: 100, close: 'tab close' },
])(
  'closes the opened $label without moving focus and keeps the error when pane run fails',
  async ({ width, close }) => {
    const herdr = herdrFake(width);
    herdr.failCall('pane run', new Error('herdr failed: run refused'));

    const { run, herdrCalls, records } = await fixture(herdr);

    await expect(run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane)).rejects.toThrow(
      'run refused',
    );

    expect(steps(herdrCalls)).toContain(close);
    expect(steps(herdrCalls)).not.toContain('tab focus');
    expect(await records()).toHaveLength(1);
  },
);

it.each([
  { label: 'the pane is already gone', closeError: 'pane_not_found', expected: 'run refused' },
  { label: 'close fails otherwise', closeError: 'socket closed', expected: 'socket closed' },
])('reports $expected when pane run fails and $label', async ({ closeError, expected }) => {
  const herdr = herdrFake();
  herdr.failCall('pane run', new Error('herdr failed: run refused'));
  herdr.failCall('pane close', new Error(`herdr failed: ${closeError}`));

  const { run } = await fixture(herdr);

  await expect(run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane)).rejects.toThrow(
    expected,
  );
});

it('keeps the run error and closes nothing when pane run fails and the terminal is gone', async () => {
  const herdr = herdrFake();
  herdr.failCall('pane run', new Error('herdr failed: run refused'), true);

  const { run, herdrCalls } = await fixture(herdr);

  await expect(run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane)).rejects.toThrow(
    'run refused',
  );

  expect(steps(herdrCalls)).not.toContain('pane close');
});

it('keeps the herdr error as the cause of the failure that names the record', async () => {
  const herdr = herdrFake();
  herdr.failCall('pane run', socketClosed());

  const { run } = await fixture(herdr);

  const failure = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane).catch(
    (error: unknown) => error,
  );

  expect((failure as Error).cause).toBeInstanceOf(Error);
});

it('refuses an open call that has no paths', async () => {
  const { run } = await fixture();

  await expect(run({ action: 'open' })).rejects.toThrow('at least one path');
});

it('collects when the tuicr terminal is already gone', async () => {
  const herdr = herdrFake();
  const { run, setSession, herdrCalls } = await fixture(herdr);

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
  herdr.exit(tuicr(herdr).terminalId);
  await setSession([comment('on-a', '01-slices/1-a.md')]);

  const collected = await run({
    action: 'collect',
    directory: (opened.details as { directory: string }).directory,
  });

  expect(collected.details).toMatchObject({ status: 'reviewed', comments: [{ content: 'on-a' }] });
  expect(steps(herdrCalls)).not.toContain('pane close');
});

it('collects when tuicr quit but its pane is still open', async () => {
  const herdr = herdrFake();
  const { run, setSession, herdrCalls } = await fixture(herdr, () => false);
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
  const reviewPane = tuicr(herdr).paneId;
  await setSession([comment('on-a', '01-slices/1-a.md')]);

  const collected = await run({
    action: 'collect',
    directory: (opened.details as { directory: string }).directory,
  });

  expect(collected.details).toMatchObject({ status: 'reviewed', comments: [{ content: 'on-a' }] });
  expect(herdrCalls.at(-1)).toEqual(['pane', 'close', reviewPane]);
});

it.each([
  { focused: true, restoresFocus: true },
  { focused: false, restoresFocus: false },
])(
  'closes the tab on collect and focuses the agent tab only when the tab was focused: $focused',
  async ({ focused, restoresFocus }) => {
    const herdr = herdrFake(100);
    const agentTab = herdr.layout.parent.tab_id;
    const { run, herdrCalls } = await fixture(herdr);

    const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
    const closing = ['tab', 'close', reviewTab(herdr)];

    if (!focused) {
      herdr.focus(agentTab);
    }

    herdrCalls.length = 0;

    await run({
      action: 'collect',
      directory: (opened.details as { directory: string }).directory,
    });

    const expected = restoresFocus ? [closing, ['tab', 'focus', agentTab]] : [closing];

    expect(herdrCalls.filter(([group, action]) => group === 'tab' && action !== 'list')).toEqual(
      expected,
    );

    expect(herdrCalls.find(([group, action]) => group === 'tab' && action === 'list')).toEqual([
      'tab',
      'list',
      '--workspace',
      herdr.layout.parent.workspace_id,
    ]);
  },
);

it('closes the pane open left when collect runs from a new tool instance', async () => {
  const herdr = herdrFake();
  const { run, herdrCalls } = await fixture(herdr);
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
  const reviewPane = tuicr(herdr).paneId;

  expect(steps(herdrCalls)).not.toContain('pane close');

  await run({
    action: 'collect',
    directory: (opened.details as { directory: string }).directory,
  });

  expect(herdrCalls.at(-1)).toEqual(['pane', 'close', reviewPane]);
});

it.each([
  { label: 'split', width: 200, close: 'pane close' },
  { label: 'tab', width: 100, close: 'tab close' },
])(
  'closes the opened $label and names the record when saving the placement fails',
  async ({ width, close }) => {
    const herdr = herdrFake(width);
    const { run, herdrCalls, repository } = await fixture(herdr);

    herdr.beforeCall('pane run', () => {
      placementFailure.active = true;

      onTestFinished(() => {
        placementFailure.active = false;
      });
    });

    await expect(run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane)).rejects.toThrow(
      join(repository, '.tau/draft-review/review-'),
    );

    expect(herdrCalls.at(-1)?.slice(0, 2)).toEqual(close.split(' '));
    expect(tuicr(herdr).exited).toBe(true);
  },
);

it.each(['process-info', 'close'] as const)(
  'follows a terminal moved before %s, closes it at the new pane, and waits before deleting',
  async (moveOn) => {
    const state = { checks: 0, deletedEarly: false };

    const herdr = herdrFake();
    herdr.moveDuring(`pane ${moveOn}`);

    const context = await fixture(herdr, async () => {
      state.checks += 1;
      state.deletedEarly ||= (await context.deleted()).length > 0;

      return state.checks < 3;
    });

    const { run, setSession, deleted, herdrCalls } = context;
    const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
    const firstPane = tuicr(herdr).paneId;
    await setSession([comment('on-a', '01-slices/1-a.md')]);

    const directory = (opened.details as { directory: string }).directory;
    const collected = await run({ action: 'collect', directory });
    const movedPane = tuicr(herdr).paneId;

    expect(collected.details).toMatchObject({ status: 'reviewed' });
    expect(movedPane).not.toBe(firstPane);

    const infoPane = moveOn === 'process-info' ? movedPane : firstPane;

    expect(herdrCalls).toContainEqual(['pane', 'process-info', '--pane', infoPane]);
    expect(herdrCalls).toContainEqual(['pane', 'close', movedPane]);
    expect(state.checks).toBe(3);
    expect(state.deletedEarly).toBe(false);
    expect(await deleted()).toEqual(['on-a']);
  },
);

it.each([
  { label: 'empty output', answer: '' },
  { label: 'a missing process_info', answer: JSON.stringify({ result: {} }) },
  {
    label: 'a missing foreground_processes',
    answer: JSON.stringify({ result: { process_info: {} } }),
  },
  {
    label: 'a non-array foreground_processes',
    answer: JSON.stringify({ result: { process_info: { foreground_processes: 'x' } } }),
  },
  { label: 'a non-number pid', answer: processInfo('abc' as unknown as number) },
])(
  'refuses $label from process-info, deletes nothing, and keeps the record',
  async ({ answer }) => {
    const herdr = herdrFake();
    const { run, setSession, deleted, records } = await fixture(herdr);

    const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
    herdr.malformedEvidence(tuicr(herdr).terminalId, 'processInfo', answer);
    await setSession([comment('on-a', '01-slices/1-a.md')]);

    const directory = (opened.details as { directory: string }).directory;

    await expect(run({ action: 'collect', directory })).rejects.toThrow(directory);

    expect(await deleted()).toEqual([]);
    expect(await records()).toHaveLength(1);
  },
);

it('names the bad process-info output in the error', async () => {
  const herdr = herdrFake();
  const { run } = await fixture(herdr);

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
  herdr.malformedEvidence(tuicr(herdr).terminalId, 'processInfo', '{"result":{"process_info":{}}}');
  const directory = (opened.details as { directory: string }).directory;

  await expect(run({ action: 'collect', directory })).rejects.toThrow('process_info');
});

it.each([
  { label: 'a missing tabs', answer: () => JSON.stringify({ result: {} }) },
  { label: 'a non-array tabs', answer: () => JSON.stringify({ result: { tabs: 'x' } }) },
  { label: 'empty output', answer: () => '' },
  { label: 'an entry with no fields', answer: () => JSON.stringify({ result: { tabs: [{}] } }) },
  {
    label: 'a string focused',
    answer: (tabId: string) =>
      JSON.stringify({ result: { tabs: [{ tab_id: tabId, focused: 'yes' }] } }),
  },
  {
    label: 'a null entry after the focused tab',
    answer: (tabId: string) =>
      JSON.stringify({ result: { tabs: [{ tab_id: tabId, focused: true }, null] } }),
  },
])('refuses $label from tab list, deletes nothing, and keeps the record', async ({ answer }) => {
  const herdr = herdrFake(100);
  const { run, setSession, deleted, records, herdrCalls } = await fixture(herdr);

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
  herdr.malformedTabList(answer(reviewTab(herdr)));
  await setSession([comment('on-a', '01-slices/1-a.md')]);

  const directory = (opened.details as { directory: string }).directory;

  await expect(run({ action: 'collect', directory })).rejects.toThrow(directory);

  expect(await deleted()).toEqual([]);
  expect(await records()).toHaveLength(1);
  expect(steps(herdrCalls)).not.toContain('tab close');
});
