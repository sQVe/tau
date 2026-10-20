import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import type { Exec } from '../../../exec.js';
import { createDraftReviewTool } from '../tool.js';
import type { DraftReviewRuntime } from '../tool.js';

type ProcessCheck = (processId: number) => boolean | Promise<boolean>;

export type Herdr = (argumentsList: string[], signal: AbortSignal | undefined) => Promise<string>;

interface TuicrComment {
  id: string;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  comment_type: string;
  content: string;
}

type DraftReviewTool = ReturnType<typeof createDraftReviewTool>;

interface ReviewFixture {
  repository: string;
  data: string;
  run: (
    parameters: Record<string, unknown>,
    paneId?: string,
    signal?: AbortSignal,
  ) => ReturnType<DraftReviewTool['execute']>;
  setSession: (comments: unknown) => Promise<void>;
  deleted: () => Promise<string[]>;
  records: () => Promise<string[]>;
  real: (name: string) => string;
  herdrCalls: string[][];
}

export const paneInfo = JSON.stringify({
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
    if (mutation.linkTo) {
      fs.rmSync(mutation.path);
      fs.symlinkSync(mutation.linkTo, mutation.path);
    } else {
      fs.writeFileSync(mutation.path, mutation.content);
    }
  }
  fs.appendFileSync(path.join(data, 'deleted.log'), id + '\\n');
} else {
  process.exit(2);
}
`;

export const comment = (id: string, path: string | null, content = id): TuicrComment => ({
  id,
  path,
  start_line: path === null ? null : 2,
  end_line: path === null ? null : 3,
  comment_type: 'issue',
  content,
});

export const layoutInfo = (width: number, zoomed = false): string =>
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

const paneListing = JSON.stringify({
  result: {
    panes: [
      { pane_id: 'w:p1', terminal_id: 't1', workspace_id: 'w', tab_id: 'w:t1' },
      { pane_id: 'w:p2', terminal_id: 't2', workspace_id: 'w', tab_id: 'w:t1' },
      { pane_id: 'w:p3', terminal_id: 't3', workspace_id: 'w', tab_id: 'w:t2' },
    ],
  },
});

export const tabInfo = JSON.stringify({
  result: {
    tab: { tab_id: 'w:t2' },
    root_pane: {
      pane_id: 'w:p3',
      terminal_id: 't3',
      workspace_id: 'w',
      tab_id: 'w:t2',
    },
  },
});

export const fixture = async (
  herdr?: Herdr,
  isProcessRunning: ProcessCheck = () => false,
): Promise<ReviewFixture> => {
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
      const listing = argumentsList[0] === 'pane' && argumentsList[1] === 'list' && answer === '';
      const fallback = wide ? layoutInfo(200) : answer;

      return {
        stdout: listing ? paneListing : fallback,
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

  const runtime = (paneId?: string): DraftReviewRuntime => ({
    exec,
    herdrPaneId: () => paneId,
    isProcessRunning,
  });

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

export const stagingOf = (command: string): string => /'([^']+)'$/.exec(command)?.[1] ?? '';
