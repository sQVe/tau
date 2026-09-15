import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { expect, it } from 'vitest';

import { saveDiagnostics } from './diagnostics.js';
import { maximumTotalBytes } from './types.js';

it('reports decoded byte counts and truncation without splitting UTF-8 characters', async ({
  onTestFinished,
}) => {
  for (const raw of [
    Buffer.alloc(1000, 255),
    Buffer.alloc(maximumTotalBytes, 255),
    Buffer.from('€'.repeat(10923)),
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'tau-diagnostic-bytes-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const decoder = new StringDecoder('utf8');
    const text = decoder.write(raw) + decoder.end();
    const result = await saveDiagnostics(
      { directory, durationMs: 1, timeoutMs: 30_000, exitCode: 0 },
      { stdout: '', stderr: text, stderrBytes: raw.length, code: 0, timedOut: false },
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
  const directory = await mkdtemp(join(tmpdir(), 'tau-diagnostic-errors-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'target.json'), '{"numTotalTests":1}');
  await symlink(join(directory, 'target.json'), join(directory, 'report.json'));
  await writeFile(join(directory, 'stdout.txt'), 'keep existing file');

  const result = await saveDiagnostics(
    { directory, durationMs: 1, timeoutMs: 30_000, exitCode: 0 },
    { stdout: 'useful stdout', stderr: 'useful stderr', code: 0, timedOut: false },
  );

  expect(result.error).toContain('not a regular file');
  expect(result.error).toContain('stdout.txt');
  expect(await readFile(result.stderr!.path, 'utf8')).toBe('useful stderr');
  expect(result.excerpt).toBe('useful stderr');
  expect(await readFile(join(directory, 'stdout.txt'), 'utf8')).toBe('keep existing file');
});
