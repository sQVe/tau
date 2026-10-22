import { readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { expect, it } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { saveDiagnostics } from './diagnostics.js';
import { maximumTotalBytes } from './process.js';

const reportLimit = 8 * 1024 * 1024;

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

    const result = await saveDiagnostics(
      {
        directory,
        durationMs: 1,
        timeoutMs: 30_000,
        exitCode: 0,
        command: ['vitest'],
        started: true,
      },
      {
        stdout: '',
        stderr: text,
        stderrBytes: raw.length,
        code: 0,
        timedOut: false,
        command: ['vitest'],
        started: true,
        stdoutTruncated: false,
        stdoutBytes: 0,
      },
    );

    const saved = await readFile(result.stderr!.path);

    expect(result.stderr?.bytes).toBe(raw.length);
    expect(result.stderr).toHaveProperty('decodedBytes', Buffer.byteLength(text));
    expect(result.stderr?.truncated).toBe(Buffer.byteLength(text) > saved.length);
    expect(result.stderr?.savedBytes).toBeLessThanOrEqual(maximumTotalBytes);
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

  const result = await saveDiagnostics(
    {
      directory,
      durationMs: 1,
      timeoutMs: 30_000,
      exitCode: 0,
      command: ['vitest'],
      started: true,
    },
    {
      stdout: 'useful stdout',
      stderr: 'useful stderr',
      code: 0,
      timedOut: false,
      command: ['vitest'],
      started: true,
      stdoutTruncated: false,
      stdoutBytes: 13,
      stderrBytes: 13,
    },
  );

  expect(result.error).toContain('not a regular file');
  expect(result.error).toContain('stdout.txt');
  expect(await readFile(result.stderr!.path, 'utf8')).toBe('useful stderr');
  expect(result.excerpt).toBe('useful stderr');
  expect(await readFile(join(directory, 'stdout.txt'), 'utf8')).toBe('keep existing file');
});

const runDiagnostics = (directory: string) => ({
  directory,
  durationMs: 1,
  timeoutMs: 30_000,
  exitCode: 0,
  command: ['vitest'],
  started: true,
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

it('records no error and no report when the runner wrote no report', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-diagnostic-clean-');

  const result = await saveDiagnostics(runDiagnostics(directory), spawnResult('out', 'err'));

  expect(result.error).toBeUndefined();
  expect(result.report).toBeUndefined();
  expect(result.stdout).toMatchObject({ bytes: 3, savedBytes: 3, truncated: false });
  expect(result.stderr).toMatchObject({ bytes: 3, savedBytes: 3, truncated: false });
});

it('marks output as truncated when the process observed more bytes than it captured', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-diagnostic-capped-');

  const result = await saveDiagnostics(runDiagnostics(directory), {
    ...spawnResult('', 'captured'),
    stderrBytes: 100,
  });

  expect(result.stderr).toMatchObject({ bytes: 100, savedBytes: 8, truncated: true });
});

it.for([
  ['a small', 20],
  ['a limit-sized', reportLimit],
] as const)('keeps %s report whole', async ([, bytes], { onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-diagnostic-report-');
  await writeFile(join(directory, 'report.json'), 'x'.repeat(bytes));

  const result = await saveDiagnostics(runDiagnostics(directory), undefined);

  expect(result.report).toMatchObject({ bytes, savedBytes: bytes, truncated: false });
  expect((await stat(join(directory, 'report.json'))).size).toBe(bytes);
});
