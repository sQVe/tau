import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { parseProseReportArguments } from './proseReport.js';

let directory: string;

const script = join(import.meta.dirname, 'proseReport.ts');

const run = (args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

const replyLine = (text: string, timestamp = '2026-01-01T00:00:00Z', model = 'fixture') =>
  JSON.stringify({
    type: 'message',
    timestamp,
    message: { role: 'assistant', model, content: [{ type: 'text', text }] },
  });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tau-prose-report-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('rejects an unknown option', () => {
  expect(() => parseProseReportArguments(['--nope'])).toThrow(/--nope/);

  expect(() => parseProseReportArguments(['--nope'])).toThrow(
    /Usage: node scripts\/proseReport\.ts/,
  );
});

it('rejects a count that is not a positive integer', () => {
  expect(() => parseProseReportArguments(['--sample', '0'])).toThrow(/--sample/);

  expect(() => parseProseReportArguments(['--files', 'x'])).toThrow(/--files/);
});

it('reports a missing session directory', () => {
  const sessions = join(directory, 'missing');
  const result = run(['--sessions', sessions]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`Session directory not found: ${sessions}`);
});

it('skips a malformed session line', async () => {
  const sessions = join(directory, 'sessions');
  const project = join(sessions, '--code-personal-tau--');

  await mkdir(project, { recursive: true });

  const file = join(project, 'session.jsonl');

  await writeFile(file, `${replyLine('A pause—then more.')}\n{"type":`);

  const result = run(['--sessions', sessions]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Skipped lines: 1');
  expect(result.stderr).toContain(`Skipped malformed line ${file}:2`);
});

it('reports an unreadable text file', async () => {
  const sessions = join(directory, 'sessions');
  const missing = join(directory, 'missing.md');

  await mkdir(sessions, { recursive: true });

  const result = run(['--sessions', sessions, '--text', missing]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`Cannot read text file: ${missing}`);
});

it('ranks replies by timestamp', async () => {
  const sessions = join(directory, 'sessions');
  const project = join(sessions, '--code-personal-tau--');

  await mkdir(project, { recursive: true });

  await writeFile(
    join(project, 'session.jsonl'),
    [
      replyLine('An old pause—then more.', '2026-01-01T00:00:00Z'),
      replyLine('A new pause then more.', '2026-01-02T00:00:00Z'),
    ].join('\n'),
  );

  const result = run(['--sessions', sessions, '--replies', '1']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('| emDash | 0 | 0 |');
});
