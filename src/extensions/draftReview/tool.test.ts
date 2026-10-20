import { getEventListeners } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Value } from 'typebox/value';
import { expect, it, onTestFinished, vi } from 'vitest';

import type { Exec } from '../../exec.js';
import { saveCollectedRecord } from './collectedRecord.js';
import {
  comment,
  fixture,
  layoutInfo,
  paneInfo,
  stagingOf,
  tabInfo,
} from './fixtures/reviewFixture.js';
import type { Herdr } from './fixtures/reviewFixture.js';
import { readReview } from './stage.js';
import { createDraftReviewTool } from './tool.js';

it('prints the command outside herdr, then collects only comments on reviewed files and changed files', async () => {
  const { run, setSession, deleted, records, real, herdrCalls, data } = await fixture();
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md', '.tau/slices/b.md'] });
  const manual = opened.details;

  if (manual.status !== 'manual') {
    throw new Error(`Expected a manual review, got ${manual.status}`);
  }

  const staging = stagingOf(manual.command);

  expect(manual.command).toMatch(/^tuicr --file '/);
  expect(await readFile(join(staging, 'slices/a.md'), 'utf8')).toBe('one\ntwo\n');
  expect(herdrCalls).toEqual([]);

  await writeFile(join(staging, 'slices/a.md'), 'one\nTWO\n');

  await setSession([
    comment('on-a', 'slices/a.md'),
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

  await writeFile(join(stagingOf(manual.command), 'slices/a.md'), 'user\n');
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
    'not a review record',
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

  await writeFile(join(stagingOf(manual.command), 'slices/a.md'), 'user\n');
  await setSession([comment('on-a', 'slices/a.md')]);

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

  await writeFile(join(stagingOf(manual.command), 'slices/a.md'), 'user\n');
  await setSession([comment('one', 'slices/a.md'), comment('two', 'slices/a.md')]);
  await writeFile(join(data, 'fail.txt'), 'two');

  await expect(run({ action: 'collect', directory: manual.directory })).rejects.toThrow(
    'Could not delete tuicr comment two',
  );

  expect(await deleted()).toEqual(['one']);
  expect(await readFile(real('slices/a.md'), 'utf8')).toBe('one\ntwo\n');

  // The session now holds only the comment that remains.
  await setSession([comment('two', 'slices/a.md')]);
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

const tabList = (focused: boolean) =>
  JSON.stringify({
    result: {
      tabs: [
        { tab_id: 'w:t1', focused: !focused },
        { tab_id: 'w:t2', focused },
      ],
    },
  });

const socketClosedHerdr: Herdr = async (argumentsList) => {
  const [, action] = argumentsList;

  if (action === 'split') {
    return paneInfo;
  }

  if (action === 'run') {
    throw new Error('herdr failed: socket closed');
  }

  return '';
};

it('names the record directory when another herdr call fails', async () => {
  const { run, repository } = await fixture(socketClosedHerdr);

  await expect(run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1')).rejects.toThrow(
    join(repository, '.tau/draft-review/review-'),
  );
});

it('ignores a pane that is already gone on close but names the record when close fails', async () => {
  const closeFailure: { message?: string } = {};

  const herdr: Herdr = async (argumentsList) => {
    const [, action] = argumentsList;

    if (action === 'split') {
      return paneInfo;
    }

    if (action === 'run') {
      throw new Error('herdr failed: socket closed');
    }

    if (action === 'close' && closeFailure.message !== undefined) {
      throw new Error(closeFailure.message);
    }

    return '';
  };

  const { run, repository } = await fixture(herdr);

  closeFailure.message = 'herdr failed: {"error":{"code":"pane_not_found"}}';

  await expect(run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1')).rejects.toThrow(
    'socket closed',
  );

  closeFailure.message = 'herdr failed: socket closed';

  await expect(run({ action: 'open', paths: ['.tau/slices/b.md'] }, 'w:p1')).rejects.toThrow(
    join(repository, '.tau/draft-review/review-'),
  );
});

const tabHerdr = (width: number, zoomed: boolean, onAction: Herdr = async () => ''): Herdr => {
  return async (argumentsList, signal) => {
    const [group, action] = argumentsList;

    if (action === 'layout') {
      return layoutInfo(width, zoomed);
    }

    if (group === 'tab' && action === 'create') {
      return tabInfo;
    }

    return onAction(argumentsList, signal);
  };
};

const steps = (calls: string[][]) => calls.map(([group, action]) => `${group} ${action}`);

it('opens a right split when the agent pane is 164 columns wide', async () => {
  const { run, herdrCalls } = await fixture(async (argumentsList) => {
    if (argumentsList[1] === 'layout') {
      return layoutInfo(164);
    }

    return argumentsList[1] === 'split' ? paneInfo : '';
  });

  await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');

  expect(steps(herdrCalls)).toContain('pane split');
  expect(herdrCalls.some(([group]) => group === 'tab')).toBe(false);
});

it.each([
  { width: 163, zoomed: false },
  { width: 200, zoomed: true },
])(
  'opens a tab in the agent workspace for a $width column pane, zoomed $zoomed',
  async ({ width, zoomed }) => {
    const { run, herdrCalls } = await fixture(tabHerdr(width, zoomed));

    await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');

    const create = herdrCalls.find(([group, action]) => group === 'tab' && action === 'create');

    expect(create).not.toContain('--focus');
    expect(create?.[create.indexOf('--workspace') + 1]).toBe('w');
    expect(steps(herdrCalls)).not.toContain('pane split');
    expect(herdrCalls.find(([, action]) => action === 'run')?.[2]).toBe('w:p3');
  },
);

it('collects when the user closes the review pane and the tab is already gone', async () => {
  const { run, herdrCalls } = await fixture(
    tabHerdr(100, false, async (argumentsList) => {
      if (argumentsList[1] === 'process-info') {
        return processInfo(4242);
      }

      if (argumentsList[0] === 'tab' && argumentsList[1] === 'list') {
        return tabList(true);
      }

      if (argumentsList[1] === 'close') {
        throw new Error('herdr failed: {"error":{"code":"tab_not_found"}}');
      }

      return '';
    }),
  );

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');

  const outcome = await run({
    action: 'collect',
    directory: (opened.details as { directory: string }).directory,
  });

  expect(outcome.details).toMatchObject({ status: 'reviewed' });
  expect(herdrCalls.at(-1)).toEqual(['tab', 'focus', 'w:t1']);
});

it('fails with the herdr error and opens nothing when the pane layout cannot be read', async () => {
  const { run, herdrCalls } = await fixture(async (argumentsList) => {
    if (argumentsList[1] === 'layout') {
      throw new Error('herdr failed: socket closed');
    }

    return '';
  });

  await expect(run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1')).rejects.toThrow(
    'herdr failed: socket closed',
  );

  expect(herdrCalls.map(([, action]) => action)).toEqual(['layout']);
});

const abortDuringOpen = async (step: string) => {
  const controller = new AbortController();

  const { run, setSession, deleted, records } = await fixture(async (argumentsList, signal) => {
    if (argumentsList.slice(0, 2).join(' ') === step) {
      controller.abort();
      signal?.throwIfAborted();
    }

    return argumentsList[1] === 'layout' ? layoutInfo(100) : tabInfo;
  });

  await setSession([comment('on-a', 'slices/a.md')]);

  const outcome = await run(
    { action: 'open', paths: ['.tau/slices/a.md'] },
    'w:p1',
    controller.signal,
  );

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

  await setSession([comment('on-a', 'slices/a.md')]);

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

  await rm(join(staging, 'slices/a.md'));
  await writeFile(join(staging, 'slices/b.md'), 'user\n');

  const collected = await run({ action: 'collect', directory: manual.directory });

  expect(collected.details).toMatchObject({ edits: [{ path: real('slices/b.md') }] });
  expect(await readFile(real('slices/a.md'), 'utf8')).toBe('one\ntwo\n');
});

it('fails when a staged file cannot be read, deleting nothing and keeping the review', async () => {
  const { run, setSession, deleted, manual, staging, real, records } = await manualReview([
    '.tau/slices/a.md',
    '.tau/slices/b.md',
  ]);

  await rm(join(staging, 'slices/a.md'));
  await mkdir(join(staging, 'slices/a.md'));
  await writeFile(join(staging, 'slices/b.md'), 'user\n');
  await setSession([comment('on-b', 'slices/b.md')]);

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

  await setSession([comment('one', 'slices/a.md'), comment('two', 'slices/a.md')]);
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
    comment('one', 'slices/a.md'),
    comment('two', 'slices/a.md'),
    comment('three', 'slices/a.md'),
  ]);

  await writeFile(join(data, 'fail.txt'), 'three');

  await expect(run({ action: 'collect', directory: manual.directory })).rejects.toThrow(
    /deleted before it: one, two\./,
  );
});

const crowdedLayout = (agentWidth: number, otherWidth: number) =>
  JSON.stringify({
    result: {
      layout: {
        workspace_id: 'w',
        tab_id: 'w:t1',
        zoomed: false,
        panes: [
          { pane_id: 'w:p0', rect: { width: otherWidth, height: 50, x: 0, y: 0 } },
          { pane_id: 'w:p1', rect: { width: agentWidth, height: 50, x: 0, y: 0 } },
        ],
      },
    },
  });

it.each([
  { agentWidth: 200, otherWidth: 50, placement: 'pane split' },
  { agentWidth: 50, otherWidth: 200, placement: 'tab create' },
])(
  'places the review by the agent pane width $agentWidth, not another pane',
  async ({ agentWidth, otherWidth, placement }) => {
    const { run, herdrCalls } = await fixture(async (argumentsList) => {
      if (argumentsList[1] === 'layout') {
        return crowdedLayout(agentWidth, otherWidth);
      }

      if (argumentsList[1] === 'split') {
        return paneInfo;
      }

      return argumentsList[1] === 'create' ? tabInfo : '';
    });

    await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');

    expect(steps(herdrCalls)).toContain(placement);
  },
);

it('sends herdr the split arguments for a pane beside the agent', async () => {
  const { run, herdrCalls } = await fixture(async (argumentsList) =>
    argumentsList[1] === 'split' ? paneInfo : '',
  );

  await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');

  const staging = /--file '([^']+)'/.exec(
    herdrCalls.find(([, action]) => action === 'run')?.[3] ?? '',
  )?.[1];

  expect(herdrCalls.find(([, action]) => action === 'split')).toEqual([
    'pane',
    'split',
    '--pane',
    'w:p1',
    '--direction',
    'right',
    '--cwd',
    staging,
  ]);
});

it('sends herdr the arguments for a review tab in the agent workspace', async () => {
  const { run, herdrCalls } = await fixture(tabHerdr(100, false));

  await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');

  const staging = /--file '([^']+)'/.exec(
    herdrCalls.find(([, action]) => action === 'run')?.[3] ?? '',
  )?.[1];

  expect(herdrCalls.find(([group, action]) => group === 'tab' && action === 'create')).toEqual([
    'tab',
    'create',
    '--workspace',
    'w',
    '--cwd',
    staging,
    '--label',
    expect.any(String),
  ]);
});

it('reports a tab close failure other than a missing tab and keeps the agent tab unfocused', async () => {
  const { run, herdrCalls } = await fixture(
    tabHerdr(100, false, async (argumentsList) => {
      if (argumentsList[1] === 'process-info') {
        return processInfo(4242);
      }

      if (argumentsList[0] === 'tab' && argumentsList[1] === 'list') {
        return tabList(true);
      }

      if (argumentsList[1] === 'close') {
        throw new Error('herdr failed: socket closed');
      }

      return '';
    }),
  );

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');

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

// Answers herdr like a workspace where the agent runs in w:p1 and tuicr in the pane open made.
const openHerdr =
  (onAction: Herdr = async () => ''): Herdr =>
  async (argumentsList, signal) => {
    if (argumentsList[1] === 'split') {
      return paneInfo;
    }

    if (argumentsList[1] === 'process-info') {
      return processInfo(4242);
    }

    return onAction(argumentsList, signal);
  };

it('opens tuicr beside the agent without focus and returns at once', async () => {
  const { run, herdrCalls, repository } = await fixture(openHerdr());

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');
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
    'w:p2',
    `tuicr --file '${staging}'`,
  ]);

  expect((await readReview(repository, details.directory)).placement).toEqual({
    kind: 'split',
    terminalId: 't2',
  });
});

it('opens a tab without focus, with no tab focus call', async () => {
  const { run, herdrCalls, repository } = await fixture(tabHerdr(100, false));

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');
  const create = herdrCalls.find(([group, action]) => group === 'tab' && action === 'create');

  expect(opened.details).toMatchObject({ status: 'opened' });
  expect(create).not.toContain('--focus');
  expect(steps(herdrCalls)).not.toContain('pane wait-output');
  expect(steps(herdrCalls)).not.toContain('tab focus');

  expect(herdrCalls.find(([, action]) => action === 'run')).toEqual([
    'pane',
    'run',
    'w:p3',
    `tuicr --file '${await stagingFor(repository)}'`,
  ]);

  const directory = (opened.details as { directory: string }).directory;

  expect((await readReview(repository, directory)).placement).toEqual({
    kind: 'tab',
    terminalId: 't3',
    tabId: 'w:t2',
    agentTabId: 'w:t1',
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

  const { run, records } = await fixture(async (argumentsList, signal) => {
    if (argumentsList[1] === 'split') {
      controller.abort();
      signal?.throwIfAborted();
    }

    return '';
  });

  const opened = await run(
    { action: 'open', paths: ['.tau/slices/a.md'] },
    'w:p1',
    controller.signal,
  );

  expect(opened.details).toEqual({ status: 'cancelled', comments: [], edits: [] });
  expect(await records()).toEqual([]);
});

it('closes the tuicr pane and waits for its process to exit before deleting a comment', async () => {
  const state: { running: boolean; checks: number; deletedWhileRunning: boolean } = {
    running: true,
    checks: 0,
    deletedWhileRunning: false,
  };

  const context = await fixture(
    openHerdr(async (argumentsList) => {
      if (argumentsList[1] === 'close') {
        state.running = true;
      }

      return '';
    }),
    async (processId) => {
      state.checks += 1;
      state.deletedWhileRunning ||= state.running && (await context.deleted()).length > 0;

      if (state.checks >= 3) {
        state.running = false;
      }

      return processId === 4242 && state.running;
    },
  );

  const { run, setSession, deleted, herdrCalls } = context;
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');
  await setSession([comment('on-a', 'slices/a.md')]);

  const collected = await run({
    action: 'collect',
    directory: (opened.details as { directory: string }).directory,
  });

  expect(collected.details).toMatchObject({ status: 'reviewed', comments: [{ content: 'on-a' }] });
  expect(herdrCalls.at(-1)).toEqual(['pane', 'close', 'w:p2']);
  expect(state.checks).toBe(3);
  expect(state.deletedWhileRunning).toBe(false);
  expect(await deleted()).toEqual(['on-a']);
});

it('fails naming the record when the tuicr process never exits, and deletes nothing', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  // The next poll's timer exists by the time this immediate runs.
  const { run, setSession, deleted, records, repository } = await fixture(openHerdr(), () => {
    setImmediate(() => vi.advanceTimersByTime(100));

    return true;
  });

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');
  await setSession([comment('on-a', 'slices/a.md')]);

  const directory = (opened.details as { directory: string }).directory;

  await expect(run({ action: 'collect', directory })).rejects.toThrow(directory);

  expect(await deleted()).toEqual([]);
  expect(await records()).toHaveLength(1);
  expect((await readReview(repository, directory)).recordDirectory).toBe(directory);
});

const closingHerdr = (state: { closed: boolean }) =>
  openHerdr(async (argumentsList) => {
    if (argumentsList[1] === 'close') {
      state.closed = true;
    }

    if (state.closed && argumentsList[1] === 'list') {
      return JSON.stringify({ result: { panes: [] } });
    }

    return '';
  });

it('waits on the saved tuicr process when a retry finds the terminal gone, then deletes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const state = { closed: false, running: true, checked: [] as number[] };

  const context = await fixture(closingHerdr(state), (processId) => {
    state.checked.push(processId);
    setImmediate(() => vi.advanceTimersByTime(100));

    return state.running;
  });

  const { run, setSession, deleted, records } = context;
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');
  await setSession([comment('on-a', 'slices/a.md')]);

  const directory = (opened.details as { directory: string }).directory;

  await expect(run({ action: 'collect', directory })).rejects.toThrow(directory);

  expect(await deleted()).toEqual([]);
  expect(await records()).toHaveLength(1);
  expect(state.closed).toBe(true);

  state.checked.length = 0;

  await expect(run({ action: 'collect', directory })).rejects.toThrow(directory);

  expect(state.checked).toContain(4242);
  expect(await deleted()).toEqual([]);
  expect(await records()).toHaveLength(1);

  state.running = false;

  const collected = await run({ action: 'collect', directory });

  expect(collected.details).toMatchObject({ status: 'reviewed', comments: [{ content: 'on-a' }] });
  expect(await deleted()).toEqual(['on-a']);
});

it('stops waiting on the saved tuicr process when the retry is cancelled', async () => {
  const state = { closed: false, running: true };
  const { run, setSession, deleted } = await fixture(closingHerdr(state), () => state.running);
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');
  await setSession([comment('on-a', 'slices/a.md')]);

  const directory = (opened.details as { directory: string }).directory;
  const firstTry = new AbortController();

  firstTry.abort();

  await expect(run({ action: 'collect', directory }, undefined, firstTry.signal)).rejects.toThrow(
    directory,
  );

  expect(state.closed).toBe(true);

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

  const { run } = await fixture(openHerdr(), () => {
    state.checks += 1;
    setImmediate(() => vi.advanceTimersByTime(100));

    return true;
  });

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');
  const directory = (opened.details as { directory: string }).directory;

  await expect(run({ action: 'collect', directory }, 'w:p1', controller.signal)).rejects.toThrow(
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

  const { run, setSession, deleted } = await fixture(openHerdr(), () => {
    state.checks += 1;

    return true;
  });

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');
  await setSession([comment('on-a', 'slices/a.md')]);

  const directory = (opened.details as { directory: string }).directory;
  const collecting = run({ action: 'collect', directory }, 'w:p1', controller.signal);

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
  { label: 'split', herdr: (onAction: Herdr) => openHerdr(onAction), close: 'pane close' },
  { label: 'tab', herdr: (onAction: Herdr) => tabHerdr(100, false, onAction), close: 'tab close' },
])(
  'closes the opened $label without moving focus and keeps the error when pane run fails',
  async ({ herdr, close }) => {
    const { run, herdrCalls, records } = await fixture(
      herdr(async (argumentsList) => {
        if (argumentsList[1] === 'run') {
          throw new Error('herdr failed: run refused');
        }

        return '';
      }),
    );

    await expect(run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1')).rejects.toThrow(
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
  const { run } = await fixture(
    openHerdr(async (argumentsList) => {
      if (argumentsList[1] === 'run') {
        throw new Error('herdr failed: run refused');
      }

      if (argumentsList[1] === 'close') {
        throw new Error(`herdr failed: ${closeError}`);
      }

      return '';
    }),
  );

  await expect(run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1')).rejects.toThrow(
    expected,
  );
});

it('keeps the run error and closes nothing when pane run fails and the terminal is gone', async () => {
  const state = { runFailed: false };

  const { run, herdrCalls } = await fixture(
    openHerdr(async (argumentsList) => {
      if (argumentsList[1] === 'run') {
        state.runFailed = true;
        throw new Error('herdr failed: run refused');
      }

      const gone = state.runFailed && argumentsList[1] === 'list';

      return gone ? JSON.stringify({ result: { panes: [] } }) : '';
    }),
  );

  await expect(run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1')).rejects.toThrow(
    'run refused',
  );

  expect(steps(herdrCalls)).not.toContain('pane close');
});

const listing = (paneId: string) =>
  JSON.stringify({
    result: {
      panes: [{ pane_id: paneId, terminal_id: 't2', workspace_id: 'w', tab_id: 'w:t1' }],
    },
  });

it('keeps the herdr error as the cause of the failure that names the record', async () => {
  const { run } = await fixture(socketClosedHerdr);

  const failure = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1').catch(
    (error: unknown) => error,
  );

  expect((failure as Error).cause).toBeInstanceOf(Error);
});

it('refuses an open call that has no paths', async () => {
  const { run } = await fixture();

  await expect(run({ action: 'open' })).rejects.toThrow('at least one path');
});

it('collects when the tuicr terminal is already gone', async () => {
  const { run, setSession, herdrCalls } = await fixture(async (argumentsList) => {
    if (argumentsList[1] === 'split') {
      return paneInfo;
    }

    return argumentsList[0] === 'pane' && argumentsList[1] === 'list'
      ? JSON.stringify({ result: { panes: [] } })
      : '';
  });

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');
  await setSession([comment('on-a', 'slices/a.md')]);

  const collected = await run({
    action: 'collect',
    directory: (opened.details as { directory: string }).directory,
  });

  expect(collected.details).toMatchObject({ status: 'reviewed', comments: [{ content: 'on-a' }] });
  expect(steps(herdrCalls)).not.toContain('pane close');
});

it('collects when tuicr quit but its pane is still open', async () => {
  const { run, setSession, herdrCalls } = await fixture(openHerdr(), () => false);
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');
  await setSession([comment('on-a', 'slices/a.md')]);

  const collected = await run({
    action: 'collect',
    directory: (opened.details as { directory: string }).directory,
  });

  expect(collected.details).toMatchObject({ status: 'reviewed', comments: [{ content: 'on-a' }] });
  expect(herdrCalls.at(-1)).toEqual(['pane', 'close', 'w:p2']);
});

it.each([
  {
    focused: true,
    calls: [
      ['tab', 'close', 'w:t2'],
      ['tab', 'focus', 'w:t1'],
    ],
  },
  { focused: false, calls: [['tab', 'close', 'w:t2']] },
])(
  'closes the tab on collect and focuses the agent tab only when the tab was focused: $focused',
  async ({ focused, calls }) => {
    const { run, herdrCalls } = await fixture(
      tabHerdr(100, false, async (argumentsList) => {
        if (argumentsList[1] === 'process-info') {
          return processInfo(4242);
        }

        return argumentsList[0] === 'tab' && argumentsList[1] === 'list' ? tabList(focused) : '';
      }),
    );

    const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');
    herdrCalls.length = 0;

    await run({
      action: 'collect',
      directory: (opened.details as { directory: string }).directory,
    });

    expect(herdrCalls.filter(([group, action]) => group === 'tab' && action !== 'list')).toEqual(
      calls,
    );

    expect(herdrCalls.find(([group, action]) => group === 'tab' && action === 'list')).toEqual([
      'tab',
      'list',
      '--workspace',
      'w',
    ]);
  },
);

it('closes the pane open left when collect runs from a new tool instance', async () => {
  const { run, herdrCalls } = await fixture(openHerdr());
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');

  expect(steps(herdrCalls)).not.toContain('pane close');

  await run({
    action: 'collect',
    directory: (opened.details as { directory: string }).directory,
  });

  expect(herdrCalls.at(-1)).toEqual(['pane', 'close', 'w:p2']);
});

it.each([
  {
    label: 'split',
    herdr: (onAction: Herdr) => openHerdr(onAction),
    close: ['pane', 'close', 'w:p2'],
  },
  {
    label: 'tab',
    herdr: (onAction: Herdr) => tabHerdr(100, false, onAction),
    close: ['tab', 'close', 'w:t2'],
  },
])(
  'closes the opened $label and names the record when saving the placement fails',
  async ({ herdr, close }) => {
    const hooks: { block?: () => Promise<void> } = {};

    const { run, herdrCalls, repository } = await fixture(
      herdr(async (argumentsList) => {
        if (argumentsList[1] === 'run') {
          await hooks.block?.();
        }

        return '';
      }),
    );

    hooks.block = async () => {
      const parent = join(repository, '.tau/draft-review');
      const [name] = await readdir(parent);

      const recordDirectory = join(parent, name ?? '');

      onTestFinished(() => chmod(recordDirectory, 0o700));
      await chmod(recordDirectory, 0o500);
    };

    await expect(run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1')).rejects.toThrow(
      join(repository, '.tau/draft-review/review-'),
    );

    expect(herdrCalls.at(-1)).toEqual(close);
  },
);

const processHerdr =
  (answer: string): Herdr =>
  async (argumentsList) => {
    if (argumentsList[1] === 'split') {
      return paneInfo;
    }

    return argumentsList[1] === 'process-info' ? answer : '';
  };

// The terminal t2 sits at w:p2 until `move` runs on a call to w:p2, then at w:p9.
const movingHerdr = (moveOn: 'process-info' | 'close') => {
  const state = { moved: false };

  const herdr: Herdr = async (argumentsList) => {
    const [group, action] = argumentsList;
    const target = argumentsList.at(-1);

    if (action === 'split') {
      return paneInfo;
    }

    if (group === 'pane' && action === 'list') {
      return listing(state.moved ? 'w:p9' : 'w:p2');
    }

    if (action === moveOn && target === 'w:p2' && !state.moved) {
      state.moved = true;
      throw new Error('herdr failed: {"error":{"code":"pane_not_found"}}');
    }

    return action === 'process-info' ? processInfo(4242) : '';
  };

  return herdr;
};

it.each(['process-info', 'close'] as const)(
  'follows a terminal moved before %s, closes it at the new pane, and waits before deleting',
  async (moveOn) => {
    const state = { checks: 0, deletedEarly: false };

    const context = await fixture(movingHerdr(moveOn), async () => {
      state.checks += 1;
      state.deletedEarly ||= (await context.deleted()).length > 0;

      return state.checks < 3;
    });

    const { run, setSession, deleted, herdrCalls } = context;
    const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');
    await setSession([comment('on-a', 'slices/a.md')]);

    const directory = (opened.details as { directory: string }).directory;
    const collected = await run({ action: 'collect', directory });

    expect(collected.details).toMatchObject({ status: 'reviewed' });
    const infoPane = moveOn === 'process-info' ? 'w:p9' : 'w:p2';

    expect(herdrCalls).toContainEqual(['pane', 'process-info', '--pane', infoPane]);
    expect(herdrCalls).toContainEqual(['pane', 'close', 'w:p9']);
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
    const { run, setSession, deleted, records } = await fixture(processHerdr(answer));

    const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');
    await setSession([comment('on-a', 'slices/a.md')]);

    const directory = (opened.details as { directory: string }).directory;

    await expect(run({ action: 'collect', directory })).rejects.toThrow(directory);

    expect(await deleted()).toEqual([]);
    expect(await records()).toHaveLength(1);
  },
);

it('names the bad process-info output in the error', async () => {
  const { run } = await fixture(processHerdr('{"result":{"process_info":{}}}'));

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');
  const directory = (opened.details as { directory: string }).directory;

  await expect(run({ action: 'collect', directory })).rejects.toThrow('process_info');
});

it.each([
  { label: 'a missing tabs', answer: JSON.stringify({ result: {} }) },
  { label: 'a non-array tabs', answer: JSON.stringify({ result: { tabs: 'x' } }) },
  { label: 'empty output', answer: '' },
  { label: 'an entry with no fields', answer: JSON.stringify({ result: { tabs: [{}] } }) },
  {
    label: 'a string focused',
    answer: JSON.stringify({ result: { tabs: [{ tab_id: 'w:t2', focused: 'yes' }] } }),
  },
  {
    label: 'a null entry after the focused tab',
    answer: JSON.stringify({ result: { tabs: [{ tab_id: 'w:t2', focused: true }, null] } }),
  },
])('refuses $label from tab list, deletes nothing, and keeps the record', async ({ answer }) => {
  const { run, setSession, deleted, records, herdrCalls } = await fixture(
    tabHerdr(100, false, async (argumentsList) => {
      if (argumentsList[1] === 'process-info') {
        return processInfo(4242);
      }

      return argumentsList[0] === 'tab' && argumentsList[1] === 'list' ? answer : '';
    }),
  );

  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');
  await setSession([comment('on-a', 'slices/a.md')]);

  const directory = (opened.details as { directory: string }).directory;

  await expect(run({ action: 'collect', directory })).rejects.toThrow(directory);

  expect(await deleted()).toEqual([]);
  expect(await records()).toHaveLength(1);
  expect(steps(herdrCalls)).not.toContain('tab close');
});
