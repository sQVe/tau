import { appendFile, chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { declinedExec } from '../../../tests/declinedExecFake.js';
import { createTemporaryRepository, git } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { createMutationCheckTool } from './mutationTool.js';
import { createFullCheckTool } from './tool.js';

interface RunParameters {
  mode: 'changed' | 'audit';
  base?: string;
  paths?: string[];
  maxMutants?: number;
}

const changedParameters: RunParameters = { mode: 'changed', base: 'HEAD' };

const survivor = {
  file: 'src/a.ts',
  line: 3,
  column: 7,
  mutator: 'Regex',
  original: '/a+/',
  replacement: '/a/',
  covered: true,
};

const passReport = { version: 1, mode: 'changed', status: 'pass', survivors: [], unmutated: [] };

const survivorReport = { ...passReport, status: 'survivors', survivors: [survivor] };

// Counts each run, prints `report` on stdout, waits for `gate` when given, and exits with `code`.
// Each run appends the arguments it received as one JSON line to `counter`. With `ending` signal it
// kills itself, and with hang it writes nothing and never exits.
const fakeScript = (
  counter: string,
  report: unknown,
  code: number,
  gate?: string,
  ending: 'exit' | 'signal' | 'hang' = 'exit',
) => `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(counter)}, JSON.stringify(process.argv.slice(1)) + '\\n');
if (${JSON.stringify(ending)} === 'signal') process.kill(process.pid, 'SIGKILL');
if (${JSON.stringify(ending)} === 'hang') setInterval(() => undefined, 1000);
const finish = () => {
  process.stdout.write(${JSON.stringify(typeof report === 'string' ? report : JSON.stringify(report))});
  process.exit(${code});
};
if (${JSON.stringify(ending)} === 'hang') undefined;
else if (${JSON.stringify(gate ?? '')} === '') finish();
else setInterval(() => { if (fs.existsSync(${JSON.stringify(gate ?? '')})) finish(); }, 10);
`;

const fixture = async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-mutation-check-');

  const root = await createTemporaryRepository(onTestFinished, 'tau-mutation-check-repo-');
  const counter = join(directory, 'count.txt');
  const gate = join(directory, 'gate');

  await writeFile(counter, '');
  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  await git(root, 'remote', 'add', 'origin', 'git@github.com:owner/mutation.git');
  await mkdir(join(root, '.pi'));

  const scriptArgv = (
    report: unknown,
    code: number,
    gated = false,
    ending: 'exit' | 'signal' | 'hang' = 'exit',
  ) => [
    process.execPath,
    '-e',
    fakeScript(counter, report, code, gated ? gate : undefined, ending),
  ];

  const configure = (
    report: unknown,
    code: number,
    gated = false,
    ending: 'exit' | 'signal' | 'hang' = 'exit',
  ) =>
    writeFile(
      join(root, '.pi', 'tau.json'),
      JSON.stringify({ mutation: { argv: scriptArgv(report, code, gated, ending) } }),
    );

  const configureFullCheck = async (argv: string[]) => {
    const path = join(root, '.pi', 'tau.json');
    const current = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

    await writeFile(path, JSON.stringify({ ...current, fullCheck: { argv } }));
  };

  const context = { cwd: root, isProjectTrusted: () => true, ui: { notify: () => undefined } };

  const run = (
    parameters: RunParameters = changedParameters,
    updates: string[] = [],
    idleLimitMilliseconds?: number,
  ) =>
    createMutationCheckTool({
      agentDirectory: directory,
      exec: declinedExec,
      pollMilliseconds: 10,
      ...(idleLimitMilliseconds === undefined ? {} : { idleLimitMilliseconds }),
    }).execute(
      'call',
      parameters,
      undefined,
      (update) => {
        const [first] = update.content;
        updates.push(first?.type === 'text' ? first.text : '');
      },
      context as never,
    );

  const receivedArguments = async (): Promise<string[][]> => {
    const lines = (await readFile(counter, 'utf8')).split('\n').filter((line) => line !== '');

    return lines.map((line) => JSON.parse(line) as string[]);
  };

  const runCount = async () => (await receivedArguments()).length;

  return {
    directory,
    root,
    configureFullCheck,
    gate,
    configure,
    scriptArgv,
    context,
    run,
    runCount,
    receivedArguments,
  };
};

const waitFor = async (condition: () => Promise<boolean> | boolean) => {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await condition()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  throw new Error('Timed out waiting for the condition.');
};

const textOf = (result: { content: { type: string; text?: string }[] }): string => {
  const [first] = result.content;

  return first?.type === 'text' ? (first.text ?? '') : '';
};

it('passes with survivors and lists the file, line, mutator, and change of each', async () => {
  const { configure, run } = await fixture();

  await configure(survivorReport, 2);

  const result = await run();
  const text = textOf(result);

  expect(result.details).toMatchObject({ passed: true, status: 'survivors', reused: false });

  expect(result.details?.survivors).toMatchObject([
    { file: 'src/a.ts', line: 3, mutator: 'Regex', original: '/a+/', replacement: '/a/' },
  ]);

  expect(text).toContain('Mutation check passed (status survivors)');
  expect(text).toContain('src/a.ts:3\n  Regex: /a+/ => /a/');
});

it('counts no-coverage mutants apart from covered survivors and groups them by line', async () => {
  const { configure, run } = await fixture();

  const other = { ...survivor, mutator: 'StringLiteral', original: '"x"', replacement: '""' };
  const uncovered = { ...survivor, line: 9, covered: false };

  await configure({ ...survivorReport, survivors: [survivor, other, uncovered] }, 2);

  const text = textOf(await run());

  expect(text).toContain(
    [
      'Covered survivors: 2 mutants on 1 line.',
      'src/a.ts:3',
      '  Regex: /a+/ => /a/',
      '  StringLiteral: "x" => ""',
      'No coverage: 1 mutant on 1 line.',
      'src/a.ts:9',
      '  Regex: /a+/ => /a/',
    ].join('\n'),
  );
});

it('fails on survivors with unmutated files and saves nothing for reuse', async () => {
  const { configure, run, runCount } = await fixture();

  await configure({ ...survivorReport, unmutated: ['src/b.ts'] }, 2);

  expect((await run()).details?.passed).toBe(false);
  expect((await run()).details?.reused).toBe(false);
  expect(await runCount()).toBe(2);
});

it('fails on survivors with an exit other than 0 or 2 and saves nothing', async () => {
  const { configure, run, runCount } = await fixture();

  await configure(survivorReport, 1);

  expect((await run()).details?.passed).toBe(false);
  expect((await run()).details?.reused).toBe(false);
  expect(await runCount()).toBe(2);
});

it('returns the saved log of an unchanged state after a pass without running the script', async () => {
  const { configure, run, runCount } = await fixture();

  await configure(passReport, 0);

  const first = await run();
  const second = await run();
  const [text] = second.content;

  expect(first.details).toMatchObject({ passed: true, reused: false });
  expect(second.details).toMatchObject({ passed: true, reused: true });
  expect(text?.type === 'text' ? text.text : '').toContain('Reused the saved passing log');
  expect(await runCount()).toBe(1);
});

it('reuses a passing run with survivors and lists the same survivors', async () => {
  const { configure, run, runCount } = await fixture();

  await configure(survivorReport, 2);

  const first = await run();
  const second = await run();

  expect(second.details).toMatchObject({ passed: true, reused: true, status: 'survivors' });
  expect(second.details?.survivors).toEqual(first.details?.survivors);
  expect(textOf(second)).toContain('src/a.ts:3\n  Regex: /a+/ => /a/');
  expect(await runCount()).toBe(1);
});

it.each([
  { label: 'missing', damage: (path: string) => rm(path) },
  { label: 'unparsable', damage: (path: string) => writeFile(path, 'not json') },
])('runs the script again when the saved report is $label', async ({ damage }) => {
  const { configure, root, run, runCount } = await fixture();

  await configure(survivorReport, 2);
  await run();

  const logs = join(root, '.tau', 'checks', 'mutation');
  const stdoutFile = (await readdir(logs)).find((name) => name.endsWith('.stdout'));

  await damage(join(logs, stdoutFile ?? 'missing.stdout'));

  const second = await run();

  expect(second.details).toMatchObject({ passed: true, reused: false });
  expect(await runCount()).toBe(2);
});

it.each([
  { label: 'an error status', report: { ...passReport, status: 'error', error: 'boom' } },
  { label: 'unmutated files', report: { ...survivorReport, unmutated: ['src/b.ts'] } },
])('runs the script again when the saved report has $label', async ({ report }) => {
  const { configure, root, run, runCount } = await fixture();

  await configure(survivorReport, 2);
  await run();

  const logs = join(root, '.tau', 'checks', 'mutation');
  const stdoutFile = (await readdir(logs)).find((name) => name.endsWith('.stdout'));

  await writeFile(join(logs, stdoutFile ?? 'missing.stdout'), JSON.stringify(report));

  const second = await run();

  expect(second.details?.reused).toBe(false);
  expect(await runCount()).toBe(2);
});

it('saves a record after survivors in audit mode that exit 0', async () => {
  const { configure, run, runCount } = await fixture();

  await configure(survivorReport, 0);

  const parameters: RunParameters = { mode: 'audit', paths: ['src/a.ts'] };
  const first = await run(parameters);
  const second = await run(parameters);

  expect(first.details?.passed).toBe(true);
  expect(second.details).toMatchObject({ reused: true, status: 'survivors' });
  expect(await runCount()).toBe(1);
});

it('fails with an error that names a report that breaks the format', async () => {
  const { configure, run } = await fixture();

  await configure({ ...passReport, version: 2 }, 0);

  await expect(run()).rejects.toThrow('version must be 1');

  await configure('not json', 0);

  await expect(run()).rejects.toThrow('not valid JSON');

  await configure({ ...passReport, survivors: [{ file: 'a.ts' }] }, 2);

  await expect(run()).rejects.toThrow('survivors[0]');
});

it.each([
  { label: 'pass with survivors', report: { ...passReport, survivors: [survivor] } },
  {
    label: 'nothing with survivors',
    report: { ...passReport, status: 'nothing', survivors: [survivor] },
  },
  { label: 'pass with unmutated files', report: { ...passReport, unmutated: ['src/b.ts'] } },
])('rejects a $label report and saves nothing for reuse', async ({ report }) => {
  const { configure, run, runCount } = await fixture();

  await configure(report, 0);

  await expect(run()).rejects.toThrow('The mutation report is invalid');
  await expect(run()).rejects.toThrow('The mutation report is invalid');
  expect(await runCount()).toBe(2);
});

it('parses a report with an extra top-level field', async () => {
  const { configure, run } = await fixture();

  await configure({ ...passReport, extra: { anything: true } }, 0);

  const result = await run();

  expect(result.details).toMatchObject({ passed: true, status: 'pass' });
});

it('rejects a repository without the mutation key and names the key', async () => {
  const { root, run, runCount } = await fixture();

  await writeFile(join(root, '.pi', 'tau.json'), '{}');

  await expect(run()).rejects.toThrow('mutation.argv');
  expect(await runCount()).toBe(0);
});

it('rejects a mutation key in the user file', async () => {
  const { directory, configure, run, runCount } = await fixture();

  await configure(passReport, 0);
  await writeFile(join(directory, 'tau.json'), JSON.stringify({ mutation: { argv: ['x'] } }));

  await expect(run()).rejects.toThrow('.pi/tau.json');
  expect(await runCount()).toBe(0);
});

it.each<{ name: string; parameters: RunParameters }>([
  { name: 'paths in changed mode', parameters: { mode: 'changed', base: 'HEAD', paths: ['a'] } },
  { name: 'no paths in audit mode', parameters: { mode: 'audit' } },
  { name: 'an option as a path', parameters: { mode: 'audit', paths: ['--config'] } },
  { name: 'a base in audit mode', parameters: { mode: 'audit', base: 'HEAD', paths: ['a'] } },
  { name: 'no base without origin/HEAD', parameters: { mode: 'changed' } },
  { name: 'a base that names no commit', parameters: { mode: 'changed', base: 'no-such-ref' } },
  { name: 'an option as a base', parameters: { mode: 'changed', base: '--output=x' } },
])('rejects $name and runs no script', async ({ parameters }) => {
  const { configure, run, runCount } = await fixture();

  await configure(passReport, 0);

  await expect(run(parameters)).rejects.toThrow(/\S/u);
  expect(await runCount()).toBe(0);
});

it('waits on the lock of a running mutation check for a full check of the same repository', async () => {
  const { directory, gate, configure, configureFullCheck, context, run, runCount } =
    await fixture();

  await configure(passReport, 0, true);

  await configureFullCheck([process.execPath, '-e', '0']);

  const mutation = run();

  await waitFor(async () => (await runCount()) === 1);

  const updates: string[] = [];

  const fullCheck = createFullCheckTool({
    agentDirectory: directory,
    exec: declinedExec,
    pollMilliseconds: 10,
  }).execute(
    'call',
    {},
    undefined,
    (update) => {
      const [first] = update.content;
      updates.push(first?.type === 'text' ? first.text : '');
    },
    context as never,
  );

  await waitFor(() => updates.length > 0);
  await appendFile(gate, '');

  const [mutationResult, fullCheckResult] = await Promise.all([mutation, fullCheck]);

  expect(updates[0]).toContain('mutation check');
  expect(mutationResult.details?.passed).toBe(true);
  expect(fullCheckResult.details?.passed).toBe(true);
});

it('waits on the lock of a running full check for a mutation check of the same repository', async () => {
  const { directory, gate, configure, configureFullCheck, context, run } = await fixture();

  await configure(passReport, 0);

  await configureFullCheck([
    process.execPath,
    '-e',
    "const fs = require('node:fs'); const [started, gate] = process.argv.slice(1); fs.writeFileSync(started, ''); setInterval(() => { if (fs.existsSync(gate)) process.exit(0); }, 10);",
    join(directory, 'started'),
    gate,
  ]);

  const fullCheck = createFullCheckTool({
    agentDirectory: directory,
    exec: declinedExec,
    pollMilliseconds: 10,
  }).execute('call', {}, undefined, undefined, context as never);

  await waitFor(async () => {
    try {
      await readFile(join(directory, 'started'));

      return true;
    } catch {
      return false;
    }
  });

  const updates: string[] = [];
  const mutation = run(changedParameters, updates);

  await waitFor(() => updates.length > 0);
  await appendFile(gate, '');

  const [fullCheckResult, mutationResult] = await Promise.all([fullCheck, mutation]);

  expect(updates[0]).toContain('full check or mutation check');
  expect(fullCheckResult.details?.passed).toBe(true);
  expect(mutationResult.details?.passed).toBe(true);
});

it('passes the resolved base commit to the script in changed mode', async () => {
  const { root, configure, run, receivedArguments } = await fixture();
  const head = await git(root, 'rev-parse', 'HEAD');

  await configure(passReport, 0);
  await run({ mode: 'changed', base: 'HEAD' });

  expect(await receivedArguments()).toEqual([['changed', head]]);
});

it('passes the paths to the script in audit mode', async () => {
  const { configure, run, receivedArguments } = await fixture();

  await configure(passReport, 0);
  await run({ mode: 'audit', paths: ['src/a.ts', 'src/b.ts'] });

  expect(await receivedArguments()).toEqual([['audit', 'src/a.ts', 'src/b.ts']]);
});

it('passes the mutant cap to the script only when it is set', async () => {
  const { configure, run, receivedArguments } = await fixture();

  await configure(passReport, 0);
  await run({ mode: 'audit', paths: ['src/a.ts'], maxMutants: 7 });
  await run({ mode: 'audit', paths: ['src/b.ts'] });

  expect(await receivedArguments()).toEqual([
    ['audit', 'src/a.ts', '--max-mutants', '7'],
    ['audit', 'src/b.ts'],
  ]);
});

it('does not reuse the passing record of a full check with the same command', async () => {
  const { directory, scriptArgv, configure, configureFullCheck, context, run, runCount } =
    await fixture();

  await configure(survivorReport, 0);

  await configureFullCheck([...scriptArgv(survivorReport, 0), 'audit', 'src/a.ts']);

  const full = await createFullCheckTool({
    agentDirectory: directory,
    exec: declinedExec,
    pollMilliseconds: 10,
  }).execute('call', {}, undefined, undefined, context as never);

  const mutation = await run({ mode: 'audit', paths: ['src/a.ts'] });

  expect(full.details?.passed).toBe(true);
  expect(mutation.details).toMatchObject({ passed: true, reused: false, status: 'survivors' });
  expect(mutation.details?.survivors).toHaveLength(1);
  expect(await runCount()).toBe(2);
});

it('passes on a nothing report', async () => {
  const { configure, run } = await fixture();

  await configure({ ...passReport, status: 'nothing' }, 0);

  expect((await run()).details).toMatchObject({ passed: true, status: 'nothing' });
});

it('fails on an error report and shows its error and the unmutated files', async () => {
  const { configure, run } = await fixture();

  await configure(
    { ...passReport, status: 'error', error: 'Stryker blew up', unmutated: ['src/b.ts'] },
    1,
  );

  const result = await run();
  const [first] = result.content;
  const text = first?.type === 'text' ? first.text : '';

  expect(result.details).toMatchObject({ passed: false, status: 'error', unmutated: ['src/b.ts'] });
  expect(text).toContain('Error: Stryker blew up');
  expect(text).toContain('Not mutated: src/b.ts');
});

it('fails on a pass report with a nonzero exit and saves nothing', async () => {
  const { configure, run, runCount } = await fixture();

  await configure(passReport, 1);

  expect((await run()).details?.passed).toBe(false);
  expect((await run()).details?.reused).toBe(false);
  expect(await runCount()).toBe(2);
});

it('fails when a signal ends the script', async () => {
  const { configure, run } = await fixture();

  await configure(passReport, 0, false, 'signal');

  const result = await run();
  const [first] = result.content;

  expect(result.details).toMatchObject({ passed: false, exitCode: null });
  expect(first?.type === 'text' ? first.text : '').toContain('signal SIGKILL');
});

it('fails and says so when the script writes nothing for the idle limit', async () => {
  const { configure, run } = await fixture();

  await configure(passReport, 0, false, 'hang');

  const result = await run(undefined, [], 100);
  const [first] = result.content;

  expect(result.details).toMatchObject({ passed: false, idle: true });
  expect(first?.type === 'text' ? first.text : '').toContain('it was hung');
});

it('rejects a repository whose origin names no owner and name', async () => {
  const { root, configure, run, runCount } = await fixture();

  await configure(passReport, 0);
  await git(root, 'remote', 'set-url', 'origin', '/tmp/some-path');

  await expect(run()).rejects.toThrow('owner/name');
  expect(await runCount()).toBe(0);
});

it('reuses a passing audit run after origin/HEAD moves', async () => {
  const { root, configure, run, runCount } = await fixture();
  const parameters: RunParameters = { mode: 'audit', paths: ['src/a.ts'] };

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await git(root, 'commit', '--quiet', '-am', 'second');
  await git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1');
  await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  await configure(passReport, 0);

  const first = await run(parameters);

  await git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

  const second = await run(parameters);

  expect(first.details?.reused).toBe(false);
  expect(second.details).toMatchObject({ passed: true, reused: true });
  expect(await runCount()).toBe(1);
});

it('rejects an untrusted repository that sets mutation and names the ignored file', async () => {
  const { directory, root, configure, runCount } = await fixture();

  await configure(passReport, 0);

  const untrusted = { cwd: root, isProjectTrusted: () => false, ui: { notify: () => undefined } };

  const outcome = createMutationCheckTool({
    agentDirectory: directory,
    exec: declinedExec,
    pollMilliseconds: 10,
  }).execute('call', changedParameters, undefined, undefined, untrusted as never);

  await expect(outcome).rejects.toThrow(join(root, '.pi', 'tau.json'));
  expect(await runCount()).toBe(0);
});

it('passes but saves no record when the record cannot be written, so the next call runs again', async () => {
  const { root, scriptArgv, run, runCount } = await fixture();
  const checks = join(root, '.tau', 'checks', 'mutation');

  const [command = '', flag = '', code = ''] = scriptArgv(passReport, 0);
  const blocking = `require('node:fs').chmodSync(${JSON.stringify(checks)}, 0o500);${code}`;

  await writeFile(
    join(root, '.pi', 'tau.json'),
    JSON.stringify({ mutation: { argv: [command, flag, blocking] } }),
  );

  onTestFinished(() => chmod(checks, 0o700).catch(() => undefined));

  const first = await run();
  const [text] = first.content;

  await chmod(checks, 0o700);

  const second = await run();

  expect(first.details?.passed).toBe(true);
  expect(first.details?.recordError).toBeDefined();
  expect(text?.type === 'text' ? text.text : '').toContain('No reusable record was saved');
  expect(second.details?.reused).toBe(false);
  expect(await runCount()).toBe(2);
});
