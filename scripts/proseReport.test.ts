import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

const longSentence = `${Array.from({ length: 41 }, () => 'word').join(' ')}.`;

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

  await writeFile(file, ['', '[1]', '{"type":', replyLine('A pause—then more.')].join('\n'));

  const result = run(['--sessions', sessions]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Replies checked: 1');
  expect(result.stdout).toContain('Skipped lines: 1');
  expect(result.stdout).toContain('| emDash | 1 | 1 |');
  expect(result.stdout).toContain('session.jsonl:4');
  expect(result.stdout).toContain('A pause—then more.');
  expect(result.stderr).toContain(`Skipped malformed line ${file}:3`);
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
      replyLine('A new pause—then more.', '2026-01-02T00:00:00Z'),
      replyLine(longSentence, '2026-01-01T00:00:00Z'),
    ].join('\n'),
  );

  const result = run(['--sessions', sessions, '--replies', '1']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Replies checked: 1');
  expect(result.stdout).toContain('session.jsonl:1');
  expect(result.stdout).toContain('A new pause—then more.');
  expect(result.stdout).toContain('| longSentence | 0 | 0 |');
  expect(result.stdout).not.toContain('word word');
});

it('ranks replies by full path at equal timestamps', async () => {
  const sessions = join(directory, 'sessions');
  const first = join(sessions, '--code-personal-tau-a--');
  const second = join(sessions, '--code-personal-tau-z--');

  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });

  await writeFile(join(first, 'z.jsonl'), replyLine('A pause—then more.'));
  await writeFile(join(second, 'a.jsonl'), replyLine(longSentence));

  const result = run(['--sessions', sessions, '--replies', '1']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Replies checked: 1');
  expect(result.stdout).toContain('| emDash | 1 | 1 |');
  expect(result.stdout).toContain('| longSentence | 0 | 0 |');
});

it('ranks a reply without a timestamp last', async () => {
  const sessions = join(directory, 'sessions');
  const project = join(sessions, '--code-personal-tau--');

  await mkdir(project, { recursive: true });

  const undated = JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      model: 'fixture',
      content: [{ type: 'text', text: 'A pause—then more.' }],
    },
  });

  await writeFile(
    join(project, 'session.jsonl'),
    [undated, replyLine(longSentence, '1900-01-01T00:00:00Z')].join('\n'),
  );

  const result = run(['--sessions', sessions, '--replies', '1']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Replies checked: 1');
  expect(result.stdout).toContain('| longSentence | 1 | 1 |');
  expect(result.stdout).toContain('| emDash | 0 | 0 |');
});

it('skips an unreadable session file', async () => {
  const sessions = join(directory, 'sessions');
  const project = join(sessions, '--code-personal-tau--');

  await mkdir(project, { recursive: true });

  const file = join(project, 'session.jsonl');

  await writeFile(file, replyLine('A pause—then more.'));
  await chmod(file, 0o000);

  const result = run(['--sessions', sessions]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Replies checked: 0');
  expect(result.stdout).toContain('Skipped lines: 1');
  expect(result.stderr).toContain(`Skipped unreadable file ${file}`);
});

it('reads only JSONL files under matching project directories', async () => {
  const sessions = join(directory, 'sessions');
  const matching = join(sessions, '--code-personal-tau--');
  const nested = join(matching, 'nested');
  const other = join(sessions, '--other-project--');

  await mkdir(nested, { recursive: true });
  await mkdir(other, { recursive: true });
  await mkdir(join(matching, 'folder.jsonl'), { recursive: true });

  await writeFile(join(nested, 'session.jsonl'), replyLine('A pause—then more.'));
  await writeFile(join(other, 'session.jsonl'), replyLine(longSentence));
  await writeFile(join(matching, 'notes.txt'), replyLine(longSentence));
  await writeFile(join(sessions, 'top.jsonl'), replyLine(longSentence));

  const result = run(['--sessions', sessions]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Replies checked: 1');
  expect(result.stdout).toContain('Skipped lines: 0');
  expect(result.stdout).toContain('| emDash | 1 | 1 |');
  expect(result.stdout).toContain('| longSentence | 0 | 0 |');
  expect(result.stderr).not.toContain(join(matching, 'folder.jsonl'));
});
