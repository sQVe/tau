import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { declinedExec } from '../../../tests/declinedExecFake.js';
import { createTemporaryRepository, git } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { createMutationCheckTool } from './mutationTool.js';
import { createFullCheckTool } from './tool.js';

type ToolKind = 'full_check' | 'mutation_check';

const toolKinds: { name: ToolKind }[] = [{ name: 'full_check' }, { name: 'mutation_check' }];

const passReport = { version: 1, mode: 'changed', status: 'pass', survivors: [], unmutated: [] };

const commandSource = (
  counter: string,
  gate: string | undefined,
  printReport: boolean,
  edit: boolean,
): string => `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(counter)}, 'x');
${edit ? "fs.appendFileSync('tracked.txt', 'more\\n');" : ''}
const finish = () => {
  ${printReport ? `process.stdout.write(${JSON.stringify(JSON.stringify(passReport))});` : ''}
  process.exit(0);
};
const gate = ${JSON.stringify(gate ?? '')};
if (gate === '') finish();
else setInterval(() => { if (fs.existsSync(gate)) finish(); }, 10);
`;

const fixture = async (kind: ToolKind) => {
  const directory = temporaryDirectory(onTestFinished, `tau-check-flow-${kind}-`);
  const root = await createTemporaryRepository(onTestFinished, 'tau-check-flow-repo-');
  const counter = join(directory, 'count.txt');
  const gate = join(directory, 'gate');

  await writeFile(counter, '');
  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  await git(root, 'remote', 'add', 'origin', 'git@github.com:owner/flow.git');
  await mkdir(join(root, '.pi'));

  const key = kind === 'full_check' ? 'fullCheck' : 'mutation';
  const checksPath = kind === 'full_check' ? 'checks' : 'checks/mutation';
  const printReport = kind === 'mutation_check';

  const configure = async (
    options: { gate?: boolean; edit?: boolean; repositoryLock?: boolean } = {},
  ) => {
    const source = commandSource(
      counter,
      options.gate === true ? gate : undefined,
      printReport,
      options.edit === true,
    );

    const sections: Record<string, Record<string, unknown>> = {
      [key]: { argv: [process.execPath, '-e', source] },
    };

    if (options.repositoryLock === true) {
      await writeFile(
        join(directory, 'tau.json'),
        JSON.stringify({
          fullCheck: { repositories: { 'owner/flow': { lockScope: 'repository' } } },
        }),
      );
    }

    return writeFile(join(root, '.pi', 'tau.json'), JSON.stringify(sections));
  };

  const context = { cwd: root, isProjectTrusted: () => true, ui: { notify: () => undefined } };

  const run = (updates: string[] = []) => {
    const onUpdate = (update: { content: { type: string; text?: string }[] }) => {
      const [first] = update.content;

      updates.push(first?.type === 'text' ? (first.text ?? '') : '');
    };

    if (kind === 'full_check') {
      return createFullCheckTool({
        agentDirectory: directory,
        exec: declinedExec,
        pollMilliseconds: 10,
      }).execute('call', {}, undefined, onUpdate, context as never);
    }

    return createMutationCheckTool({
      agentDirectory: directory,
      exec: declinedExec,
      pollMilliseconds: 10,
    }).execute('call', { mode: 'changed', base: 'HEAD' }, undefined, onUpdate, context as never);
  };

  const runCount = async () => (await readFile(counter, 'utf8')).length;

  const savedRecords = async () =>
    (await readdir(join(root, '.tau', checksPath))).filter((name) => name.endsWith('.json'));

  return { root, directory, counter, gate, configure, run, runCount, savedRecords };
};

const startHoldingFullCheck = async (agentDirectory: string, started: string, gate: string) => {
  const root = await createTemporaryRepository(onTestFinished, 'tau-check-flow-holder-');

  await writeFile(join(root, 'tracked.txt'), 'holder\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'holder');
  await git(root, 'remote', 'add', 'origin', 'git@github.com:owner/flow.git');
  await mkdir(join(root, '.pi'));

  const source = `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(started)}, '');
setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) process.exit(0); }, 10);
`;

  await writeFile(
    join(root, '.pi', 'tau.json'),
    JSON.stringify({
      fullCheck: { argv: [process.execPath, '-e', source] },
    }),
  );

  return createFullCheckTool({
    agentDirectory,
    exec: declinedExec,
    pollMilliseconds: 10,
  }).execute('call', {}, undefined, undefined, {
    cwd: root,
    isProjectTrusted: () => true,
    ui: { notify: () => undefined },
  } as never);
};

it.each(toolKinds)(
  '$name reuses a passing record before it waits for the repository lock',
  async ({ name }) => {
    const state = await fixture(name);
    const started = join(state.directory, `started-${name}`);
    const holderGate = join(state.directory, `holder-gate-${name}`);

    await state.configure({ repositoryLock: true });
    const first = await state.run();

    const holder = startHoldingFullCheck(state.directory, started, holderGate);

    onTestFinished(async () => {
      await writeFile(holderGate, '');
      await holder.catch(() => undefined);
    });

    await vi.waitFor(
      () => {
        expect(existsSync(started)).toBe(true);
      },
      { timeout: 5000 },
    );

    const updates: string[] = [];
    let reusedResult: Awaited<ReturnType<typeof state.run>> | undefined;

    const reused = state.run(updates).then((value) => {
      reusedResult = value;

      return value;
    });

    await vi.waitFor(
      () => {
        expect(reusedResult !== undefined || updates.length > 0).toBe(true);
      },
      { timeout: 5000 },
    );

    expect(reusedResult).toBeDefined();
    expect(updates).toEqual([]);

    await writeFile(holderGate, '');

    const [resolved, holderResult] = await Promise.all([reused, holder]);

    expect(resolved.details).toMatchObject({ passed: true, reused: true });
    expect(resolved.details?.logPath).toBe(first.details?.logPath);
    expect(holderResult.details?.passed).toBe(true);
    expect(await state.runCount()).toBe(1);
  },
);

it.each(toolKinds)(
  '$name waits for another checkout using the user repository lock scope',
  async ({ name }) => {
    const state = await fixture(name);
    const started = join(state.directory, `started-${name}`);
    const holderGate = join(state.directory, `holder-gate-${name}`);

    await state.configure({ repositoryLock: true });

    const holder = startHoldingFullCheck(state.directory, started, holderGate);

    onTestFinished(async () => {
      await writeFile(holderGate, '');
      await holder.catch(() => undefined);
    });

    await vi.waitFor(() => {
      expect(existsSync(started)).toBe(true);
    });

    const updates: string[] = [];
    const waiting = state.run(updates);

    await vi.waitFor(() => {
      expect(updates).toHaveLength(1);
    });

    expect(await state.runCount()).toBe(0);

    await writeFile(holderGate, '');

    const [holderResult, result] = await Promise.all([holder, waiting]);

    expect(holderResult.details?.passed).toBe(true);
    expect(result.details).toMatchObject({ passed: true, reused: false });
    expect(await state.runCount()).toBe(1);
  },
);

it.each(toolKinds)(
  '$name reuses a passing record saved by a call that finished while it waited',
  async ({ name }) => {
    const state = await fixture(name);

    await state.configure({ gate: true });

    const running = state.run();

    await vi.waitFor(async () => {
      expect(await state.runCount()).toBe(1);
    });

    const updates: string[] = [];
    const waiting = state.run(updates);

    await vi.waitFor(() => {
      expect(updates).toHaveLength(1);
    });

    await writeFile(state.gate, '');

    const [started, reused] = await Promise.all([running, waiting]);

    expect(updates[0]).toContain('Waiting');
    expect(started.details).toMatchObject({ passed: true, reused: false });
    expect(reused.details).toMatchObject({ passed: true, reused: true });
    expect(reused.details?.logPath).toBe(started.details?.logPath);
    expect(await state.runCount()).toBe(1);
  },
);

it.each(toolKinds)(
  '$name runs again when the inputs change during the run and saves no record',
  async ({ name }) => {
    const state = await fixture(name);

    await state.configure({ edit: true });

    const first = await state.run();
    const second = await state.run();

    expect(first.details).toMatchObject({ passed: true, reused: false });
    expect(second.details).toMatchObject({ passed: true, reused: false });
    expect(await state.runCount()).toBe(2);
    expect(await state.savedRecords()).toEqual([]);
  },
);
