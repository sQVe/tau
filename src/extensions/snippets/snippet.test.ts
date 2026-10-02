import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, onTestFinished as afterThisTest } from 'vitest';

import { loadSnippets } from './snippet.js';

const snippetFile = (name: string, body: string) => `---\nname: ${name}\n---\n${body}\n`;

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
      '---',
      '',
      'Ask questions until you know what to do.',
      '',
    ].join('\n');

    expect(await loadOne('ask-questions.md', raw)).toEqual({
      id: 'ask-questions',
      name: 'Ask questions',
      description: 'Ask until we agree',
      body: 'Ask questions until you know what to do.',
    });
  });

  it('falls back to the filename for the name', async () => {
    const snippet = await loadOne(
      'bare-snippet.md',
      '---\nunrelated: value\n---\nVerify the facts.\n',
    );

    expect(snippet).toEqual({
      id: 'bare-snippet',
      name: 'bare-snippet',
      description: '',
      body: 'Verify the facts.',
    });
  });

  it('strips quotes and ignores blank fields, unknown fields, and letter case', async () => {
    const raw = [
      '---',
      'NAME: "Quoted name"',
      "description: 'Quoted description'",
      'description:',
      'unknown: ignored',
      'not a field',
      '---',
      'Body.',
    ].join('\n');

    expect(await loadOne('quoted.md', raw)).toMatchObject({
      name: 'Quoted name',
      description: 'Quoted description',
    });
  });

  it('reads a file that uses carriage returns and drops them from the body', async () => {
    const raw = '---\r\nname: Windows\r\n---\r\nFirst line.\r\nSecond line.\r\n';

    expect(await loadOne('windows.md', raw)).toMatchObject({
      name: 'Windows',
      body: 'First line.\nSecond line.',
    });
  });

  it('accepts an empty frontmatter block, since every field is optional', async () => {
    expect(await loadOne('bare.md', '---\n---\nJust a body.\n')).toEqual({
      id: 'bare',
      name: 'bare',
      description: '',
      body: 'Just a body.',
    });
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
  it('reads markdown files, skips other files, and sorts by id', async ({ onTestFinished }) => {
    const directory = await mkdtemp(join(tmpdir(), 'tau-snippets-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));

    await writeFile(join(directory, 'second.md'), snippetFile('Second', 'Second.'));
    await writeFile(join(directory, 'first.md'), snippetFile('First', 'First.'));
    await writeFile(join(directory, 'later.md'), snippetFile('Zulu', 'Later.'));
    await writeFile(join(directory, 'notes.txt'), snippetFile('Ignored', 'Ignored.'));
    await writeFile(join(directory, 'broken.md'), 'No frontmatter here.');

    const snippets = await loadSnippets(directory);

    expect(snippets.map((snippet) => snippet.name)).toEqual(['First', 'Zulu', 'Second']);
    expect(snippets.map((snippet) => snippet.id)).toEqual(['first', 'later', 'second']);
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
    await writeFile(join(directory, 'real.md'), snippetFile('Real', 'Real body.'));

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
});
