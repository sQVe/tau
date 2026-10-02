import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, onTestFinished as afterThisTest } from 'vitest';

import { loadSnippets } from './snippet.js';

const snippetFile = (name: string, order: number, body: string) =>
  `---\nname: ${name}\norder: ${order}\n---\n${body}\n`;

// Each case loads one file the way the extension does, so it covers the parser and the loader together.
const loadOne = async (filename: string, content: string) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-snippet-parse-'));
  afterThisTest(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, filename), content);
  const [snippet] = await loadSnippets(directory);

  return snippet ?? null;
};

describe('parsing a snippet file', () => {
  it('reads the frontmatter fields and the trimmed body', async () => {
    const raw = [
      '---',
      'name: Ask questions',
      'description: Ask until we agree',
      'order: 20',
      '---',
      '',
      'Ask questions until you know what to do.',
      '',
    ].join('\n');

    expect(await loadOne('ask-questions.md', raw)).toEqual({
      id: 'ask-questions',
      name: 'Ask questions',
      description: 'Ask until we agree',
      order: 20,
      body: 'Ask questions until you know what to do.',
    });
  });

  it('falls back to the filename and a last-place order', async () => {
    const snippet = await loadOne(
      'bare-snippet.md',
      '---\nunrelated: value\n---\nVerify the facts.\n',
    );

    expect(snippet).toEqual({
      id: 'bare-snippet',
      name: 'bare-snippet',
      description: '',
      order: 9999,
      body: 'Verify the facts.',
    });
  });

  it('strips quotes and ignores blank fields, unknown fields, and letter case', async () => {
    const raw = [
      '---',
      'NAME: "Quoted name"',
      "description: 'Quoted description'",
      'order:',
      'unknown: ignored',
      'not a field',
      '---',
      'Body.',
    ].join('\n');

    expect(await loadOne('quoted.md', raw)).toMatchObject({
      name: 'Quoted name',
      description: 'Quoted description',
      order: 9999,
    });
  });

  it('reads a file that uses carriage returns and drops them from the body', async () => {
    const raw = '---\r\nname: Windows\r\norder: 5\r\n---\r\nFirst line.\r\nSecond line.\r\n';

    expect(await loadOne('windows.md', raw)).toMatchObject({
      name: 'Windows',
      order: 5,
      body: 'First line.\nSecond line.',
    });
  });

  it('accepts an empty frontmatter block, since every field is optional', async () => {
    expect(await loadOne('bare.md', '---\n---\nJust a body.\n')).toEqual({
      id: 'bare',
      name: 'bare',
      description: '',
      order: 9999,
      body: 'Just a body.',
    });
  });

  it('treats an unparsable order as a last-place order', async () => {
    expect(await loadOne('bad.md', '---\norder: soon\n---\nBody.')).toMatchObject({ order: 9999 });
  });

  it.for([
    ['no frontmatter', 'Just a body with no frontmatter.'],
    ['an unterminated frontmatter block', '---\nname: Broken\nBody.'],
    ['an empty body', '---\nname: Empty\n---\n   \n'],
  ])('returns null for %s', async ([, raw]) => {
    expect(await loadOne('invalid.md', raw!)).toBeNull();
  });
});

describe('loadSnippets', () => {
  it('reads markdown files, skips other files, and sorts by order', async ({ onTestFinished }) => {
    const directory = await mkdtemp(join(tmpdir(), 'tau-snippets-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));

    await writeFile(join(directory, 'second.md'), snippetFile('Second', 20, 'Second.'));
    await writeFile(join(directory, 'first.md'), snippetFile('First', 10, 'First.'));
    await writeFile(join(directory, 'later.md'), snippetFile('Later', 99, 'Later.'));
    await writeFile(join(directory, 'notes.txt'), snippetFile('Ignored', 1, 'Ignored.'));
    await writeFile(join(directory, 'broken.md'), 'No frontmatter here.');

    const snippets = await loadSnippets(directory);

    expect(snippets.map((snippet) => snippet.name)).toEqual(['First', 'Second', 'Later']);
    expect(snippets.map((snippet) => snippet.id)).toEqual(['first', 'second', 'later']);
  });

  it('sorts snippets with equal orders by name', async ({ onTestFinished }) => {
    const directory = await mkdtemp(join(tmpdir(), 'tau-snippets-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));

    await writeFile(join(directory, 'b.md'), snippetFile('Beta', 10, 'Beta.'));
    await writeFile(join(directory, 'a.md'), snippetFile('Alpha', 10, 'Alpha.'));

    const snippets = await loadSnippets(directory);

    expect(snippets.map((snippet) => snippet.name)).toEqual(['Alpha', 'Beta']);
  });

  it('reports a missing directory instead of returning no snippets', async () => {
    // Created then removed, so a leftover directory cannot make this pass.
    const directory = await mkdtemp(join(tmpdir(), 'tau-snippets-gone-'));
    await rm(directory, { recursive: true, force: true });

    await expect(loadSnippets(directory)).rejects.toThrow('ENOENT');
  });

  it('skips a directory whose name ends in .md', async ({ onTestFinished }) => {
    const directory = await mkdtemp(join(tmpdir(), 'tau-snippets-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));

    await mkdir(join(directory, 'draft.md'));
    await writeFile(join(directory, 'real.md'), snippetFile('Real', 10, 'Real body.'));

    const snippets = await loadSnippets(directory);

    expect(snippets.map((snippet) => snippet.name)).toEqual(['Real']);
  });
});

describe('the shipped snippets', () => {
  const shippedDirectory = fileURLToPath(new URL('./snippets/', import.meta.url));

  it('sends each paragraph as one line, so no instruction breaks mid-sentence', async () => {
    const snippets = await loadSnippets(shippedDirectory);

    expect(snippets.length).toBeGreaterThan(0);

    for (const snippet of snippets) {
      // A newline with text on both sides is a hard wrap inside a paragraph.
      expect(snippet.body, `${snippet.id} is wrapped`).not.toMatch(/[^\n]\n[^\n]/);
    }
  });

  it('loads Check the agreed plan after the approach snippets', async () => {
    const snippets = await loadSnippets(shippedDirectory);
    const approach = snippets.slice(0, 5);

    expect(approach.map((snippet) => snippet.name)).toEqual([
      'Interview me',
      'Read other panes',
      'Push back',
      "Verify, don't assume",
      'Check the agreed plan',
    ]);

    expect(approach.at(-1)).toMatchObject({
      id: 'check-agreed-plan',
      order: 50,
      body: "Read the relevant ticket, its parent, and linked prerequisites before proposing work. Compare the current plan with the implementation and recent decisions. State this task's scope, exclusions, and blockers. Flag conflicting or outdated requirements rather than silently choosing one. Do not update tickets unless asked.",
    });
  });

  it('gives every snippet a unique order', async () => {
    const snippets = await loadSnippets(shippedDirectory);
    const orders = snippets.map((snippet) => snippet.order);

    expect(new Set(orders).size).toBe(orders.length);
  });
});
