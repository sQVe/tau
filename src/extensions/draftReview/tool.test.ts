import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Value } from 'typebox/value';
import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import type { Exec } from '../../exec.js';
import { saveCollectedRecord } from './collectedRecord.js';
import { createDraftReviewTool } from './tool.js';
import type { DraftReviewRuntime } from './tool.js';

type Herdr = (argumentsList: string[], signal: AbortSignal | undefined) => Promise<string>;

const paneInfo = JSON.stringify({
  result: {
    pane: { pane_id: 'w:p2', terminal_id: 't2', workspace_id: 'w', tab_id: 'w:t1' },
  },
});

const fakeScript = (data: string) => `
const fs = require('node:fs');
const path = require('node:path');
const data = ${JSON.stringify(data)};
const [, , , subcommand, flag, value, , id] = process.argv;
const read = (name) => fs.readFileSync(path.join(data, name), 'utf8');
if (subcommand === 'list') {
  fs.appendFileSync(path.join(data, 'repos.log'), value + '\\n');
  process.stdout.write(fs.existsSync(path.join(data, 'sessions.txt')) ? read('sessions.txt') : '[]');
} else if (subcommand === 'comments') {
  process.stdout.write(read('comments.txt'));
} else if (subcommand === 'delete') {
  const failFile = path.join(data, 'fail.txt');
  if (fs.existsSync(failFile) && read('fail.txt') === id) {
    process.stderr.write('delete refused');
    process.exit(1);
  }
  const mutateFile = path.join(data, 'mutate.json');
  if (fs.existsSync(mutateFile)) {
    const mutation = JSON.parse(read('mutate.json'));
    fs.writeFileSync(mutation.path, mutation.content);
  }
  fs.appendFileSync(path.join(data, 'deleted.log'), id + '\\n');
} else {
  process.exit(2);
}
`;

const comment = (id: string, path: string | null, content = id) => ({
  id,
  path,
  start_line: path === null ? null : 2,
  end_line: path === null ? null : 3,
  comment_type: 'issue',
  content,
});

const layoutInfo = (width: number, zoomed = false) =>
  JSON.stringify({
    result: {
      layout: {
        workspace_id: 'w',
        tab_id: 'w:t1',
        zoomed,
        panes: [{ pane_id: 'w:p1', rect: { width, height: 50, x: 0, y: 0 } }],
      },
    },
  });

const tabInfo = JSON.stringify({
  result: { tab: { tab_id: 'w:t2' }, root_pane: { pane_id: 'w:p3' } },
});

const fixture = async (herdr?: Herdr) => {
  const repository = await createTemporaryRepository(onTestFinished, 'tau-draft-review-repo-');
  const data = await mkdtemp(join(tmpdir(), 'tau-fake-tuicr-'));
  onTestFinished(() => rm(data, { recursive: true, force: true }));

  // Staging goes under os.tmpdir(), and failed reviews keep it for a retry. Point it at data so
  // every test removes its staging.
  vi.stubEnv('TMPDIR', data);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const script = join(data, 'tuicr.cjs');
  await writeFile(script, fakeScript(data));
  await mkdir(join(repository, '.tau/slices'), { recursive: true });
  await mkdir(join(repository, '.tau/tickets'), { recursive: true });
  await writeFile(join(repository, '.tau/slices/a.md'), 'one\ntwo\n');
  await writeFile(join(repository, '.tau/slices/b.md'), 'bee\n');
  await writeFile(join(repository, '.tau/tickets/c.md'), 'sea\n');

  const herdrCalls: string[][] = [];

  const exec: Exec = async (command, argumentsList, options) => {
    if (command === 'herdr') {
      herdrCalls.push(argumentsList);

      const answer = (await herdr?.(argumentsList, options?.signal)) ?? '';
      const wide = argumentsList[1] === 'layout' && answer === '';

      return {
        stdout: wide ? layoutInfo(200) : answer,
        stderr: '',
        code: 0,
        killed: false,
      };
    }

    return new Promise((resolve) => {
      execFile(process.execPath, [script, ...argumentsList], (error, stdout, stderr) => {
        const code = typeof error?.code === 'number' ? error.code : Number(error !== null);

        resolve({ stdout, stderr, code, killed: false });
      });
    });
  };

  const runtime = (paneId?: string): DraftReviewRuntime => ({ exec, herdrPaneId: () => paneId });

  const run = (parameters: Record<string, unknown>, paneId?: string, signal?: AbortSignal) =>
    createDraftReviewTool(runtime(paneId)).execute('call', parameters as never, signal, undefined, {
      cwd: repository,
    } as never);

  const setSession = async (comments: unknown) => {
    await writeFile(
      join(data, 'sessions.txt'),
      JSON.stringify([{ path: join(data, 'session.json') }]),
    );

    await writeFile(
      join(data, 'comments.txt'),
      typeof comments === 'string' ? comments : JSON.stringify(comments),
    );
  };

  const deleted = async () => {
    const log = join(data, 'deleted.log');

    return existsSync(log) ? (await readFile(log, 'utf8')).split('\n').filter(Boolean) : [];
  };

  const records = () => readdir(join(repository, '.tau/draft-review'));
  const real = (name: string) => join(repository, '.tau', name);

  return { repository, data, run, setSession, deleted, records, real, herdrCalls };
};

const stagingOf = (command: string) => /'([^']+)'$/.exec(command)?.[1] ?? '';

it('prints the command outside herdr, then collects only comments on reviewed files and changed files', async () => {
  const { run, setSession, deleted, records, real, herdrCalls, data } = await fixture();
  const opened = await run({ action: 'review', paths: ['.tau/slices/a.md', '.tau/slices/b.md'] });
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
  const opened = await run({ action: 'review', paths: ['.tau/slices/a.md'] });
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
  const opened = await run({ action: 'review', paths: ['.tau/slices/a.md'] });
  const manual = opened.details;

  if (manual.status !== 'manual') {
    throw new Error('Expected a manual review.');
  }

  const withoutSession = await run({ action: 'collect', directory: manual.directory });

  expect(withoutSession.details).toEqual({ status: 'reviewed', comments: [], edits: [] });

  const second = await run({ action: 'review', paths: ['.tau/slices/a.md'] });

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
  const opened = await run({ action: 'review', paths: ['.tau/slices/a.md'] });
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

  await expect(run({ action: 'review', paths: [] })).rejects.toThrow('at least one path');
  await expect(run({ action: 'review', paths: ['outside.md'] })).rejects.toThrow('outside');

  await expect(run({ action: 'review', paths: ['.tau/missing.md'] })).rejects.toThrow(
    'does not exist',
  );

  await expect(run({ action: 'review', paths: ['.tau/slices'] })).rejects.toThrow('not a file');

  await expect(run({ action: 'collect', directory: '.tau/slices' })).rejects.toThrow(
    'not a review record',
  );

  await expect(run({ action: 'collect' })).rejects.toThrow('needs a directory');
  await expect(records()).rejects.toThrow(/ENOENT/);
});

it('opens tuicr in a pane beside the agent, waits, closes the pane, and collects', async () => {
  let staging = '';
  const hooks: { session?: (comments: unknown) => Promise<void> } = {};

  const herdr: Herdr = async (argumentsList) => {
    const [, action] = argumentsList;

    if (action === 'split') {
      staging = argumentsList[argumentsList.indexOf('--cwd') + 1] ?? '';

      return paneInfo;
    }

    if (action === 'wait-output') {
      await writeFile(join(staging, 'slices/a.md'), 'one\nTWO\n');
      await hooks.session?.([comment('on-a', 'slices/a.md'), comment('on-c', 'tickets/c.md')]);
    }

    return '';
  };

  const { run, setSession, deleted, herdrCalls, real } = await fixture(herdr);
  hooks.session = setSession;

  const outcome = await run({ action: 'review', paths: ['.tau/slices/a.md'] }, 'w:p1');

  expect(herdrCalls.map(([, action]) => action)).toEqual([
    'layout',
    'split',
    'run',
    'wait-output',
    'close',
  ]);

  expect(herdrCalls[1]).toContain('w:p1');
  expect(herdrCalls[2]?.[3]).toContain(`tuicr --file '${staging}'`);

  expect(outcome.details).toMatchObject({
    status: 'reviewed',
    comments: [{ path: real('slices/a.md'), content: 'on-a' }],
    edits: [{ path: real('slices/a.md'), status: 'applied' }],
  });

  expect(await deleted()).toEqual(['on-a']);
});

it('returns no comments, deletes nothing, and writes nothing when the wait is cancelled', async () => {
  const controller = new AbortController();
  let staging = '';

  const herdr: Herdr = async (argumentsList, signal) => {
    const [, action] = argumentsList;

    if (action === 'split') {
      staging = argumentsList[argumentsList.indexOf('--cwd') + 1] ?? '';

      return paneInfo;
    }

    if (action === 'wait-output') {
      await writeFile(join(staging, 'slices/a.md'), 'edited\n');
      controller.abort();
      signal?.throwIfAborted();
    }

    return '';
  };

  const { run, setSession, deleted, herdrCalls, real, records } = await fixture(herdr);
  await setSession([comment('on-a', 'slices/a.md')]);

  const outcome = await run(
    { action: 'review', paths: ['.tau/slices/a.md'] },
    'w:p1',
    controller.signal,
  );

  expect(outcome.details).toEqual({ status: 'cancelled', comments: [], edits: [] });
  expect(herdrCalls.at(-1)?.[1]).toBe('close');
  expect(await deleted()).toEqual([]);
  expect(await readFile(real('slices/a.md'), 'utf8')).toBe('one\ntwo\n');
  expect(await records()).toEqual([]);
  expect(existsSync(staging)).toBe(false);
});

it('reports a conflict and keeps the agent content when the real file changes during collect', async () => {
  const { run, setSession, data, real } = await fixture();
  const opened = await run({ action: 'review', paths: ['.tau/slices/a.md'] });
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
  const opened = await run({ action: 'review', paths: ['.tau/slices/a.md'] });
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

it('collects normally when the user closes the pane during the wait', async () => {
  const hooks: { session?: (comments: unknown) => Promise<void> } = {};

  const herdr: Herdr = async (argumentsList) => {
    const [, action] = argumentsList;

    if (action === 'split') {
      return paneInfo;
    }

    if (action === 'wait-output') {
      await hooks.session?.([comment('on-a', 'slices/a.md')]);

      throw new Error('herdr failed: {"error":{"code":"pane_not_found"}}');
    }

    return '';
  };

  const { run, setSession, deleted } = await fixture(herdr);
  hooks.session = setSession;

  const outcome = await run({ action: 'review', paths: ['.tau/slices/a.md'] }, 'w:p1');

  expect(outcome.details).toMatchObject({ status: 'reviewed', comments: [{ content: 'on-a' }] });
  expect(await deleted()).toEqual(['on-a']);
});

it('names the record directory when another herdr call fails', async () => {
  const herdr: Herdr = async (argumentsList) => {
    const [, action] = argumentsList;

    if (action === 'split') {
      return paneInfo;
    }

    if (action === 'wait-output') {
      throw new Error('herdr failed: socket closed');
    }

    return '';
  };

  const { run, repository } = await fixture(herdr);

  await expect(run({ action: 'review', paths: ['.tau/slices/a.md'] }, 'w:p1')).rejects.toThrow(
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

    if (action === 'close' && closeFailure.message !== undefined) {
      throw new Error(closeFailure.message);
    }

    return '';
  };

  const { run, repository } = await fixture(herdr);

  closeFailure.message = 'herdr failed: {"error":{"code":"pane_not_found"}}';

  const gone = await run({ action: 'review', paths: ['.tau/slices/a.md'] }, 'w:p1');

  expect(gone.details).toMatchObject({ status: 'reviewed' });

  closeFailure.message = 'herdr failed: socket closed';

  await expect(run({ action: 'review', paths: ['.tau/slices/b.md'] }, 'w:p1')).rejects.toThrow(
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

  await run({ action: 'review', paths: ['.tau/slices/a.md'] }, 'w:p1');

  expect(steps(herdrCalls)).toContain('pane split');
  expect(herdrCalls.some(([group]) => group === 'tab')).toBe(false);
});

it.each([
  { width: 163, zoomed: false },
  { width: 200, zoomed: true },
])(
  'opens a focused tab in the agent workspace for a $width column pane, zoomed $zoomed',
  async ({ width, zoomed }) => {
    const { run, herdrCalls } = await fixture(tabHerdr(width, zoomed));

    await run({ action: 'review', paths: ['.tau/slices/a.md'] }, 'w:p1');

    const create = herdrCalls.find(([group, action]) => group === 'tab' && action === 'create');

    expect(create).toContain('--focus');
    expect(create?.[create.indexOf('--workspace') + 1]).toBe('w');
    expect(steps(herdrCalls)).not.toContain('pane split');
    expect(herdrCalls.find(([, action]) => action === 'run')?.[2]).toBe('w:p3');
  },
);

it('closes the review tab, refocuses the agent tab, and collects after tuicr exits', async () => {
  const hooks: { session?: (comments: unknown) => Promise<void> } = {};

  const { run, setSession, herdrCalls, deleted } = await fixture(
    tabHerdr(100, false, async (argumentsList) => {
      if (argumentsList[1] === 'wait-output') {
        await hooks.session?.([comment('on-a', 'slices/a.md')]);
      }

      return '';
    }),
  );

  hooks.session = setSession;

  const outcome = await run({ action: 'review', paths: ['.tau/slices/a.md'] }, 'w:p1');

  expect(herdrCalls.slice(-2)).toEqual([
    ['tab', 'close', 'w:t2'],
    ['tab', 'focus', 'w:t1'],
  ]);

  expect(outcome.details).toMatchObject({ status: 'reviewed', comments: [{ content: 'on-a' }] });
  expect(await deleted()).toEqual(['on-a']);
});

it('collects when the user closes the review pane and the tab is already gone', async () => {
  const { run, herdrCalls } = await fixture(
    tabHerdr(100, false, async (argumentsList) => {
      if (argumentsList[1] === 'wait-output') {
        throw new Error('herdr failed: {"error":{"code":"pane_not_found"}}');
      }

      if (argumentsList[1] === 'close') {
        throw new Error('herdr failed: {"error":{"code":"tab_not_found"}}');
      }

      return '';
    }),
  );

  const outcome = await run({ action: 'review', paths: ['.tau/slices/a.md'] }, 'w:p1');

  expect(outcome.details).toMatchObject({ status: 'reviewed' });
  expect(herdrCalls.at(-1)).toEqual(['tab', 'focus', 'w:t1']);
});

it('closes the review tab and returns cancelled when a tab review is cancelled', async () => {
  const controller = new AbortController();

  const { run, herdrCalls } = await fixture(
    tabHerdr(100, false, async (argumentsList, signal) => {
      if (argumentsList[1] === 'wait-output') {
        controller.abort();
        signal?.throwIfAborted();
      }

      return '';
    }),
  );

  const outcome = await run(
    { action: 'review', paths: ['.tau/slices/a.md'] },
    'w:p1',
    controller.signal,
  );

  expect(outcome.details).toEqual({ status: 'cancelled', comments: [], edits: [] });

  expect(herdrCalls.slice(-2)).toEqual([
    ['tab', 'close', 'w:t2'],
    ['tab', 'focus', 'w:t1'],
  ]);
});

it('fails with the herdr error and opens nothing when the pane layout cannot be read', async () => {
  const { run, herdrCalls } = await fixture(async (argumentsList) => {
    if (argumentsList[1] === 'layout') {
      throw new Error('herdr failed: socket closed');
    }

    return '';
  });

  await expect(run({ action: 'review', paths: ['.tau/slices/a.md'] }, 'w:p1')).rejects.toThrow(
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
    { action: 'review', paths: ['.tau/slices/a.md'] },
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
  const opened = await run({ action: 'review', paths: ['.tau/slices/a.md'] });

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

it('refuses a review call that has no paths', async () => {
  const { run } = await fixture();

  await expect(run({ action: 'review' })).rejects.toThrow('at least one path');
});

it.each([
  { call: { action: 'review' }, valid: true },
  { call: { action: 'collect' }, valid: true },
  { call: { action: 'review', paths: ['.tau/a.md'] }, valid: true },
  { call: { action: 'collect', directory: '.tau/draft-review/review-1' }, valid: true },
  { call: { action: 'other' }, valid: false },
  { call: {}, valid: false },
  { call: { action: 'review', paths: [''] }, valid: false },
  { call: { action: 'collect', directory: '' }, valid: false },
])('checks the arguments $call: valid is $valid', ({ call, valid }) => {
  const { parameters } = createDraftReviewTool({
    exec: vi.fn<Exec>(),
    herdrPaneId: () => undefined,
  });

  expect(Value.Check(parameters, call)).toBe(valid);
});

const manualReview = async (paths = ['.tau/slices/a.md']) => {
  const context = await fixture();
  const opened = await context.run({ action: 'review', paths });

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
