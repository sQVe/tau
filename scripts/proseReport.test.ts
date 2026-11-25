import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { parseProseReportArguments } from './proseReport.js';

let directory: string;

const script = join(import.meta.dirname, 'proseReport.ts');

const run = (args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

const replyLine = (
  text: string,
  timestamp = '2026-01-01T00:00:00Z',
  model = 'fixture',
  id?: string,
) =>
  JSON.stringify({
    type: 'message',
    ...(id === undefined ? {} : { id }),
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

it('reports a session path that cannot be read', async () => {
  const sessions = join(directory, 'sessions');

  await writeFile(sessions, 'not a directory');

  const result = run(['--sessions', sessions]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`Cannot read session directory ${sessions}: ENOTDIR`);
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
  expect(result.stdout).toContain('Skipped files: 0');
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

  await writeFile(
    join(first, 'z.jsonl'),
    replyLine('A pause—then more.', undefined, undefined, 'first'),
  );

  await writeFile(join(second, 'a.jsonl'), replyLine(longSentence, undefined, undefined, 'second'));

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

it.skipIf(process.getuid?.() === 0)('skips an unreadable session file', async () => {
  const sessions = join(directory, 'sessions');
  const project = join(sessions, '--code-personal-tau--');

  await mkdir(project, { recursive: true });

  const file = join(project, 'session.jsonl');

  await writeFile(file, replyLine('A pause—then more.'));
  await chmod(file, 0o000);

  const result = run(['--sessions', sessions]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Replies checked: 0');
  expect(result.stdout).toContain('Skipped files: 1');
  expect(result.stdout).toContain('Skipped lines: 0');
  expect(result.stderr).toContain(`Skipped unreadable file ${file}`);
});

it.skipIf(process.getuid?.() === 0)(
  'counts an unreadable project directory and keeps the readable replies',
  async () => {
    const sessions = join(directory, 'sessions');
    const unreadable = join(sessions, '--code-personal-tau-a--');
    const readable = join(sessions, '--code-personal-tau-z--');

    await mkdir(unreadable, { recursive: true });
    await mkdir(readable, { recursive: true });
    await writeFile(join(readable, 'session.jsonl'), replyLine('A pause—then more.'));
    await chmod(unreadable, 0o000);

    const result = run(['--sessions', sessions]);

    await chmod(unreadable, 0o755);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Replies checked: 1');
    expect(result.stdout).toContain('Skipped directories: 1');
    expect(result.stdout).toContain('| emDash | 1 | 1 |');
    expect(result.stderr).toContain(`Skipped unreadable directory ${unreadable}: EACCES`);
  },
);

it('counts a copied reply once before the reply limit', async () => {
  const sessions = join(directory, 'sessions');
  const first = join(sessions, '--code-personal-tau-a--');
  const second = join(sessions, '--code-personal-tau-b--');
  const third = join(sessions, '--code-personal-tau-z--');
  const copy = replyLine('A pause—then more.', '2026-01-03T00:00:00Z', 'fixture', 'copy');

  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await mkdir(third, { recursive: true });

  await writeFile(join(first, 'session.jsonl'), copy);
  await writeFile(join(second, 'session.jsonl'), copy);

  await writeFile(
    join(third, 'session.jsonl'),
    replyLine(longSentence, '2026-01-02T00:00:00Z', 'fixture', 'other'),
  );

  const result = run(['--sessions', sessions, '--replies', '2']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Replies checked: 2');
  expect(result.stdout).toContain('| emDash | 1 | 1 |');
  expect(result.stdout).toContain('| longSentence | 1 | 1 |');
});

it('keeps distinct replies without an id at the same timestamp', async () => {
  const sessions = join(directory, 'sessions');
  const first = join(sessions, '--code-personal-tau-a--');
  const second = join(sessions, '--code-personal-tau-z--');

  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });

  await writeFile(join(first, 'session.jsonl'), replyLine('A pause—then more.'));
  await writeFile(join(second, 'session.jsonl'), replyLine(longSentence));

  const result = run(['--sessions', sessions]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Replies checked: 2');
  expect(result.stdout).toContain('| emDash | 1 | 1 |');
  expect(result.stdout).toContain('| longSentence | 1 | 1 |');
});

it('keeps the copy the recency order ranks first', async () => {
  const sessions = join(directory, 'sessions');
  const first = join(sessions, '--code-personal-tau-a--');
  const second = join(sessions, '--code-personal-tau-b--');
  const third = join(sessions, '--code-personal-tau-z--');
  const timestamp = '2026-01-01T00:00:00Z';
  const copy = replyLine('A pause—then more.', timestamp, 'fixture', 'copy');
  const distinct = replyLine(longSentence, timestamp, 'fixture', 'distinct');

  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await mkdir(third, { recursive: true });

  await writeFile(join(first, 'a.jsonl'), copy);
  await writeFile(join(second, 'b.jsonl'), copy);
  await writeFile(join(third, 'z.jsonl'), distinct);

  const result = run(['--sessions', sessions, '--replies', '2']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Replies checked: 2');
  expect(result.stdout).toContain('a.jsonl:1');
  expect(result.stdout).not.toContain('b.jsonl:1');
  expect(result.stdout).toContain('z.jsonl:1');
  expect(result.stdout).toContain('| emDash | 1 | 1 |');
  expect(result.stdout).toContain('| longSentence | 1 | 1 |');
});

// macOS compares filenames normalization-insensitively, so these é names are not distinct.
it.skipIf(process.platform === 'darwin')(
  'keeps the base reply when normalized paths tie at the limit',
  async () => {
    const sessions = join(directory, 'sessions');
    const composed = join(sessions, '--code-personal-tau-é--');
    const decomposed = join(sessions, '--code-personal-tau-e\u0301--');
    const copySource = join(sessions, '--code-personal-tau-z--');
    const timestamp = '2026-01-01T00:00:00Z';
    const copy = replyLine('Copy—reply.', timestamp, 'fixture', 'copy');
    const distinct = replyLine('Distinct—reply.', timestamp);
    const composedFile = join(composed, 'session.jsonl');
    const decomposedFile = join(decomposed, 'session.jsonl');
    const copyFile = join(copySource, 'session.jsonl');

    await mkdir(composed, { recursive: true });
    await mkdir(decomposed, { recursive: true });
    await mkdir(copySource, { recursive: true });

    await writeFile(composedFile, copy);
    await writeFile(decomposedFile, distinct);
    await writeFile(copyFile, copy);
    await utimes(composedFile, new Date('2026-01-03T00:00:00Z'), new Date('2026-01-03T00:00:00Z'));

    await utimes(
      decomposedFile,
      new Date('2026-01-02T00:00:00Z'),
      new Date('2026-01-02T00:00:00Z'),
    );

    await utimes(copyFile, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    const result = run(['--sessions', sessions, '--replies', '1']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Replies checked: 1');
    expect(result.stdout).toContain('Copy—reply.');
    expect(result.stdout).not.toContain('Distinct—reply.');
  },
);

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
  expect(result.stdout).toContain('Skipped files: 0');
  expect(result.stdout).toContain('Skipped lines: 0');
  expect(result.stdout).toContain('| emDash | 1 | 1 |');
  expect(result.stdout).toContain('| longSentence | 0 | 0 |');
  expect(result.stderr).not.toContain(join(matching, 'folder.jsonl'));
});
