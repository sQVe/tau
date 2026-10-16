import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import type { Exec } from '../../exec.js';
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

      return {
        stdout: (await herdr?.(argumentsList, options?.signal)) ?? '',
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

  expect(herdrCalls.map(([, action]) => action)).toEqual(['split', 'run', 'wait-output', 'close']);
  expect(herdrCalls[0]).toContain('w:p1');
  expect(herdrCalls[1]?.[3]).toContain(`tuicr --file '${staging}'`);

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
