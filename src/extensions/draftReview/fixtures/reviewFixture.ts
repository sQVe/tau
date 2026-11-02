import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { onTestFinished, vi } from 'vitest';

import type { ExecCall } from '../../../../tests/execFake.js';
import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { createHcFake } from '../../../../tests/hcFake.js';
import type { HcFake } from '../../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import type { Exec } from '../../../command.js';
import { createDraftReviewTool } from '../tool.js';
import type { DraftReviewRuntime } from '../tool.js';

interface TuicrComment {
  id: string;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  comment_type: string;
  content: string;
}

type DraftReviewTool = ReturnType<typeof createDraftReviewTool>;

interface HcWaitGate {
  started: Promise<void>;
  release: () => void;
}

export interface ReviewFixture {
  exec: Exec;
  calls: ExecCall[];
  hc: HcFake;
  repository: string;
  data: string;
  run: (
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
  ) => ReturnType<DraftReviewTool['execute']>;
  setSession: (comments: unknown) => Promise<void>;
  setWait: (result: { ended: boolean; reason: string }) => void;
  holdHcWait: () => HcWaitGate;
  holdHcRun: () => HcWaitGate;
  deleted: () => Promise<string[]>;
  records: () => Promise<string[]>;
  staging: () => Promise<string[]>;
  real: (name: string) => string;
}

export interface ReviewFixtureOptions {
  space?: string;
}

const reviewAddress = 'review-1';

const deferred = () => {
  const { promise, resolve } = Promise.withResolvers<undefined>();

  return {
    promise,
    resolve: () => {
      resolve(undefined);
    },
  };
};

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

export const fixture = async (options: ReviewFixtureOptions = {}): Promise<ReviewFixture> => {
  const repository = await createTemporaryRepository(onTestFinished, 'tau-draft-review-repo-');
  const data = temporaryDirectory(onTestFinished, 'tau-fake-tuicr-');

  // Staging goes under os.tmpdir(), and failed reviews keep it for a retry. Point it at data so
  // every test removes its staging.
  vi.stubEnv('TMPDIR', data);
  vi.stubEnv('HC_TERMINAL_ID', options.space === undefined ? undefined : 'manager');

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

  const hc = createHcFake();

  if (options.space !== undefined) {
    hc.reply(
      'get',
      JSON.stringify({
        address: 'manager',
        state: 'live',
        labels: { 'herdr.space': options.space },
      }),
    );
  }

  hc.reply('run', JSON.stringify({ address: reviewAddress, state: 'live' }));
  hc.reply('kill', JSON.stringify({ address: reviewAddress, state: 'closed' }));

  hc.reply(
    'wait',
    JSON.stringify({
      terminal: reviewAddress,
      ended: true,
      reason: 'exit',
      turn: 1,
      children: [],
    }),
  );

  const tuicrExec: Exec = (_command, argumentsList) =>
    new Promise((resolve) => {
      execFile(process.execPath, [script, ...argumentsList], (error, stdout, stderr) => {
        const code = typeof error?.code === 'number' ? error.code : Number(error !== null);

        resolve({ stdout, stderr, code, killed: false });
      });
    });

  const calls: ExecCall[] = [];

  let heldHc:
    | {
        command: string;
        started: () => void;
        released: Promise<void>;
        release: () => void;
      }
    | undefined;

  const exec: Exec = async (command, argumentsList, execOptions) => {
    calls.push({ command, commandArguments: [...argumentsList], signal: execOptions?.signal });

    if (command !== 'hc') {
      return tuicrExec(command, argumentsList, execOptions);
    }

    if (heldHc !== undefined && argumentsList[0] === heldHc.command) {
      const held = heldHc;
      const signal = execOptions?.signal;

      heldHc = undefined;
      held.started();

      await Promise.race([
        held.released,
        new Promise<void>((resolve) => {
          signal?.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
        }),
      ]);

      if (signal?.aborted === true) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
    }

    if (execOptions?.signal?.aborted === true) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }

    return hc.exec(command, argumentsList, execOptions);
  };

  const holdHcCommand = (command: string): HcWaitGate => {
    const started = deferred();
    const released = deferred();

    heldHc = {
      command,
      started: started.resolve,
      released: released.promise,
      release: released.resolve,
    };

    return { started: started.promise, release: released.resolve };
  };

  const holdHcWait = (): HcWaitGate => holdHcCommand('wait');

  const holdHcRun = (): HcWaitGate => holdHcCommand('run');

  const runtime: DraftReviewRuntime = { exec, connect: hc.connect };

  const run = (parameters: Record<string, unknown>, signal?: AbortSignal) =>
    createDraftReviewTool(runtime).execute('call', parameters as never, signal, undefined, {
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

  const setWait = (result: { ended: boolean; reason: string }) => {
    hc.reply('wait', JSON.stringify({ terminal: reviewAddress, turn: 1, children: [], ...result }));
  };

  const deleted = async () => {
    const log = join(data, 'deleted.log');

    return existsSync(log) ? (await readFile(log, 'utf8')).split('\n').filter(Boolean) : [];
  };

  const records = () => readdir(join(repository, '.tau/draft-review'));

  const staging = async () =>
    (await readdir(data)).filter((name) => name.startsWith('tau-draft-review-'));

  const real = (name: string) => join(repository, '.tau', name);

  return {
    exec,
    calls,
    hc,
    repository,
    data,
    run,
    setSession,
    setWait,
    holdHcWait,
    holdHcRun,
    deleted,
    records,
    staging,
    real,
  };
};

export const stagingOf = (command: string): string => /'([^']+)'$/.exec(command)?.[1] ?? '';
