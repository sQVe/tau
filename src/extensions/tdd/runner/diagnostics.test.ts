import { readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { expect, it } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { saveDiagnostics } from './diagnostics.js';
import { maximumTotalBytes } from './process.js';

const reportLimit = 8 * 1024 * 1024;

const runOverview = (directory: string) => ({
  directory,
  durationMs: 1,
  timeoutMs: 30_000,
  report: { path: join(directory, 'report.json'), format: 'json' as const },
});

const spawnResult = (stdout: string, stderr: string) => ({
  stdout,
  stderr,
  code: 0,
  timedOut: false,
  command: ['vitest'],
  started: true,
  stdoutTruncated: false,
  stdoutBytes: Buffer.byteLength(stdout),
  stderrBytes: Buffer.byteLength(stderr),
});

it('reports decoded byte counts and truncation without splitting UTF-8 characters', async ({
  onTestFinished,
}) => {
  for (const raw of [
    Buffer.alloc(1000, 255),
    Buffer.alloc(maximumTotalBytes, 255),
    Buffer.from('€'.repeat(10923)),
  ]) {
    const directory = temporaryDirectory(onTestFinished, 'tau-diagnostic-bytes-');
    const decoder = new StringDecoder('utf8');
    const text = decoder.write(raw) + decoder.end();

    const result = await saveDiagnostics(runOverview(directory), [
      {
        name: 'run',
        durationMs: 1,
        result: {
          ...spawnResult('', text),
          stderrBytes: raw.length,
          stdoutBytes: 0,
        },
      },
    ]);

    const saved = await readFile(result.stages[0]!.stderr!.path);

    expect(result.stages[0]!.stderr?.bytes).toBe(raw.length);
    expect(result.stages[0]!.stderr).toHaveProperty('decodedBytes', Buffer.byteLength(text));
    expect(result.stages[0]!.stderr?.truncated).toBe(Buffer.byteLength(text) > saved.length);
    expect(result.stages[0]!.stderr?.savedBytes).toBeLessThanOrEqual(maximumTotalBytes);
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(saved)).not.toThrow();
  }
});

it('preserves other artifacts and the excerpt when individual saves fail', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-diagnostic-errors-');
  await writeFile(join(directory, 'target.json'), '{"numTotalTests":1}');
  await symlink(join(directory, 'target.json'), join(directory, 'report.json'));
  await writeFile(join(directory, 'stdout.txt'), 'keep existing file');

  const result = await saveDiagnostics(runOverview(directory), [
    {
      name: 'run',
      durationMs: 1,
      result: {
        ...spawnResult('useful stdout', 'useful stderr'),
        stdoutBytes: 13,
        stderrBytes: 13,
      },
    },
  ]);

  expect(result.error).toContain('not a regular file');
  expect(result.error).toContain('stdout.txt');
  expect(await readFile(result.stages[0]!.stderr!.path, 'utf8')).toBe('useful stderr');
  expect(result.stages[0]!.excerpt).toBe('useful stderr');
  expect(await readFile(join(directory, 'stdout.txt'), 'utf8')).toBe('keep existing file');
});

it('records no error and no report file when the runner wrote no report', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-diagnostic-clean-');

  const result = await saveDiagnostics(runOverview(directory), [
    { name: 'run', durationMs: 1, result: spawnResult('out', 'err') },
  ]);

  expect(result.error).toBeUndefined();
  expect(result.report).toMatchObject({ path: join(directory, 'report.json'), format: 'json' });
  expect(result.report.file).toBeUndefined();
  expect(result.stages[0]!.stdout).toMatchObject({ bytes: 3, savedBytes: 3, truncated: false });
  expect(result.stages[0]!.stderr).toMatchObject({ bytes: 3, savedBytes: 3, truncated: false });
});

it('keeps the report path and format of each run and each stage output apart', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-diagnostic-stages-');
  await writeFile(join(directory, 'report.xml'), '<testsuites />');

  const result = await saveDiagnostics(
    {
      ...runOverview(directory),
      report: { path: join(directory, 'report.xml'), format: 'junit' },
    },
    [
      { name: 'list', durationMs: 1, result: spawnResult('listed', 'list warning') },
      { name: 'run', durationMs: 2, result: spawnResult('ran', 'run warning') },
    ],
  );

  expect(result.report).toMatchObject({ path: join(directory, 'report.xml'), format: 'junit' });
  expect(result.report.file).toMatchObject({ bytes: 14, savedBytes: 14, truncated: false });
  expect(result.stages.map((stage) => stage.name)).toEqual(['list', 'run']);
  expect(result.stages.map((stage) => stage.durationMs)).toEqual([1, 2]);
  expect(result.stages[0]!.stdout?.path).toBe(join(directory, 'list.stdout.txt'));
  expect(result.stages[1]!.stdout?.path).toBe(join(directory, 'run.stdout.txt'));
  expect(await readFile(result.stages[0]!.stdout!.path, 'utf8')).toBe('listed');
  expect(await readFile(result.stages[1]!.stdout!.path, 'utf8')).toBe('ran');
});

it('marks output as truncated when the process observed more bytes than it captured', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-diagnostic-capped-');

  const result = await saveDiagnostics(runOverview(directory), [
    {
      name: 'run',
      durationMs: 1,
      result: { ...spawnResult('', 'captured'), stderrBytes: 100 },
    },
  ]);

  expect(result.stages[0]!.stderr).toMatchObject({ bytes: 100, savedBytes: 8, truncated: true });
});

it.for([
  ['a small', 20],
  ['a limit-sized', reportLimit],
] as const)('keeps %s report whole', async ([, bytes], { onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-diagnostic-report-');
  await writeFile(join(directory, 'report.json'), 'x'.repeat(bytes));

  const result = await saveDiagnostics(runOverview(directory), []);

  expect(result.report.file).toMatchObject({ bytes, savedBytes: bytes, truncated: false });
  expect((await stat(join(directory, 'report.json'))).size).toBe(bytes);
});
