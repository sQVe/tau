import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { acceptsSnippets, buildSnippetMessage, loadSnippets, parseSnippet } from './snippet.js';
import type { Snippet } from './types.js';

const snippetFile = (name: string, placement: string, order: number, body: string) =>
  `---\nname: ${name}\nplacement: ${placement}\norder: ${order}\n---\n${body}\n`;

const createSnippet = (overrides: Partial<Snippet> = {}): Snippet => ({
  id: 'example.md',
  name: 'Example',
  description: '',
  placement: 'append',
  order: 10,
  body: 'Example body.',
  ...overrides,
});

describe('parseSnippet', () => {
  it('reads the frontmatter fields and the trimmed body', () => {
    const raw = [
      '---',
      'name: Ask questions',
      'description: Ask until we agree',
      'placement: prepend',
      'order: 20',
      '---',
      '',
      'Ask questions until you know what to do.',
      '',
    ].join('\n');

    expect(parseSnippet('ask-questions.md', raw)).toEqual({
      id: 'ask-questions.md',
      name: 'Ask questions',
      description: 'Ask until we agree',
      placement: 'prepend',
      order: 20,
      body: 'Ask questions until you know what to do.',
    });
  });

  it('falls back to the filename, append placement, and a last-place order', () => {
    const snippet = parseSnippet(
      'bare-snippet.md',
      '---\nunrelated: value\n---\nVerify the facts.\n',
    );

    expect(snippet).toEqual({
      id: 'bare-snippet.md',
      name: 'bare-snippet',
      description: '',
      placement: 'append',
      order: 9999,
      body: 'Verify the facts.',
    });
  });

  it('strips quotes and ignores blank fields, unknown fields, and letter case', () => {
    const raw = [
      '---',
      'NAME: "Quoted name"',
      "description: 'Quoted description'",
      'placement:',
      'unknown: ignored',
      'not a field',
      '---',
      'Body.',
    ].join('\n');

    expect(parseSnippet('quoted.md', raw)).toMatchObject({
      name: 'Quoted name',
      description: 'Quoted description',
      placement: 'append',
    });
  });

  it('reads a file that uses carriage returns and drops them from the body', () => {
    const raw =
      '---\r\nname: Windows\r\nplacement: prepend\r\n---\r\nFirst line.\r\nSecond line.\r\n';

    expect(parseSnippet('windows.md', raw)).toMatchObject({
      name: 'Windows',
      placement: 'prepend',
      body: 'First line.\nSecond line.',
    });
  });

  it.for(['Prepend', 'PREPEND'])('reads %s as the prepend placement', (placement) => {
    expect(parseSnippet('cased.md', `---\nplacement: ${placement}\n---\nBody.`)).toMatchObject({
      placement: 'prepend',
    });
  });

  it('accepts an empty frontmatter block, since every field is optional', () => {
    expect(parseSnippet('bare.md', '---\n---\nJust a body.\n')).toEqual({
      id: 'bare.md',
      name: 'bare',
      description: '',
      placement: 'append',
      order: 9999,
      body: 'Just a body.',
    });
  });

  it('treats an unparsable order as a last-place order', () => {
    expect(parseSnippet('bad.md', '---\norder: soon\n---\nBody.')).toMatchObject({ order: 9999 });
  });

  it.for([
    ['no frontmatter', 'Just a body with no frontmatter.'],
    ['an unterminated frontmatter block', '---\nname: Broken\nBody.'],
    ['an empty body', '---\nname: Empty\n---\n   \n'],
  ])('returns null for %s', ([, raw]) => {
    expect(parseSnippet('invalid.md', raw!)).toBeNull();
  });
});

describe('loadSnippets', () => {
  it('reads markdown files, skips other files, and sorts prepend before append', async ({
    onTestFinished,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), 'tau-snippets-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));

    await writeFile(join(directory, 'second.md'), snippetFile('Second', 'append', 20, 'Second.'));
    await writeFile(join(directory, 'first.md'), snippetFile('First', 'prepend', 10, 'First.'));
    await writeFile(join(directory, 'later.md'), snippetFile('Later', 'prepend', 99, 'Later.'));
    await writeFile(join(directory, 'notes.txt'), snippetFile('Ignored', 'append', 1, 'Ignored.'));
    await writeFile(join(directory, 'broken.md'), 'No frontmatter here.');

    const snippets = await loadSnippets(directory);

    expect(snippets.map((snippet) => snippet.name)).toEqual(['First', 'Later', 'Second']);
    expect(snippets.map((snippet) => snippet.id)).toEqual(['first.md', 'later.md', 'second.md']);
  });

  it('sorts snippets with equal orders by name', async ({ onTestFinished }) => {
    const directory = await mkdtemp(join(tmpdir(), 'tau-snippets-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));

    await writeFile(join(directory, 'b.md'), snippetFile('Beta', 'append', 10, 'Beta.'));
    await writeFile(join(directory, 'a.md'), snippetFile('Alpha', 'append', 10, 'Alpha.'));

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
    await writeFile(join(directory, 'real.md'), snippetFile('Real', 'append', 10, 'Real body.'));

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

  it('gives every snippet a unique order within its placement group', async () => {
    const snippets = await loadSnippets(shippedDirectory);
    const keys = snippets.map((snippet) => `${snippet.placement}:${snippet.order}`);

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('acceptsSnippets', () => {
  it.for(['/skill:commit', '/commit stage the fix', '  /skill:commit', '/my-prompt-template'])(
    'refuses the slash command %s',
    (text) => {
      expect(acceptsSnippets(text)).toBe(false);
    },
  );

  it.for(['Commit the fix.', 'Look at src/a.ts', 'Use the / operator here.'])(
    'accepts %s',
    (text) => {
      expect(acceptsSnippets(text)).toBe(true);
    },
  );
});

describe('buildSnippetMessage', () => {
  it('wraps the text with prepend bodies first and append bodies last', () => {
    const active = [
      createSnippet({ placement: 'prepend', body: 'Before one.' }),
      createSnippet({ placement: 'prepend', body: 'Before two.' }),
      createSnippet({ placement: 'append', body: 'After one.' }),
    ];

    expect(buildSnippetMessage('My message.', active)).toBe(
      'Before one.\n\nBefore two.\n\nMy message.\n\nAfter one.',
    );
  });

  it('keeps the given order within each group', () => {
    const active = [
      createSnippet({ placement: 'append', body: 'Second.' }),
      createSnippet({ placement: 'append', body: 'Third.' }),
    ];

    expect(buildSnippetMessage('First.', active)).toBe('First.\n\nSecond.\n\nThird.');
  });

  it('returns the text unchanged when nothing is active', () => {
    expect(buildSnippetMessage('My message.', [])).toBe('My message.');
  });
});
