import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { readSyncedGuides } from './syncedGuides.js';
import type { GuideFileSystem, SyncedGuides } from './syncedGuides.js';

interface BrokenRow {
  name: string;
  files?: Readonly<Record<string, string>>;
  change?: (directory: string) => void;
  reason: string[];
}

const recordName = '.sync-record.toml';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const writeFile = (directory: string, path: string, text: string) => {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  writeFileSync(join(directory, path), text);
};

const recordText = (version: string, files: Readonly<Record<string, string>>) => {
  const hashes = Object.entries(files).map(([path, text]) => `"${path}" = "${sha256(text)}"`);

  return `schema = 1\nversion = "${version}"\n\n[files]\n${hashes.join('\n')}\n`;
};

const writeGuides = (files: Readonly<Record<string, string>>) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-synced-guides-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  for (const [path, text] of Object.entries(files)) {
    writeFile(directory, path, text);
  }

  writeFile(directory, recordName, recordText('0.2.0', files));

  return directory;
};

const rules = '# Rules\n';

const coding = [
  '# Coding',
  'See [the rules](./rules.md), [a heading](../languages/rust/guide.md#rust), and [the top](#coding).',
  'See [a site](https://example.com) and [the Rust guide](../languages/rust/guide.md).',
  'An index entry is `- [NNNN: Title](./NNNN-title.md)`.',
  '<!-- [a draft](./draft.md) -->',
  '```markdown',
  '[an example](./example.md)',
  '```',
  '',
].join('\n');

const guides = {
  'shared/coding.md': coding,
  'shared/rules.md': rules,
  'languages/rust/guide.md': '# Rust\n',
  'shared/data.txt': '[not Markdown](./gone.md)\n',
};

it('reads a folder that matches its record', async () => {
  const directory = writeGuides(guides);

  writeFile(directory, 'notes.md', '[unrecorded](./gone.md)\n');

  const result = await readSyncedGuides(directory);

  expect(result).toEqual({
    kind: 'valid',
    version: '0.2.0',
    files: new Map(Object.entries(guides)),
  });
});

it.for([
  {
    name: 'a link target in angle brackets with a space',
    files: {
      ...guides,
      'shared/a b.md': '# A\n',
      'shared/rules.md': '[space](<./a b.md>)\n',
    },
  },
  {
    name: 'a link after a fence inside an HTML comment',
    files: {
      ...guides,
      'shared/rules.md': '<!--\n```markdown\n-->\n[the rules](./rules.md)\n',
    },
  },
  {
    name: 'a lone backtick before an HTML comment with a link',
    files: {
      ...guides,
      'shared/rules.md': 'A literal `\n\n<!-- `\n[ignored](./gone.md)\n-->\n',
    },
  },
  {
    name: 'a reference definition with an angle-bracket target and a title',
    files: {
      ...guides,
      'shared/a b.md': '# A\n',
      'shared/rules.md': '[rules][adr]\n\n   [adr]: <./a b.md> "Title"\n',
    },
  },
  {
    name: 'a reference definition with a plain target and a title',
    files: { ...guides, 'shared/rules.md': '[rules][adr]\n\n[adr]: ./coding.md "Title"\n' },
  },
  {
    name: 'reference definitions with a URL, an anchor, and a footnote',
    files: {
      ...guides,
      'shared/rules.md':
        '# Rules\n[a]: https://example.com/gone.md\n[b]: #rules\n[c]: ./coding.md#coding\n[^1]: A note.\n',
    },
  },
  {
    name: 'reference definitions inside a fence, a code span, and an HTML comment',
    files: {
      ...guides,
      'shared/rules.md': [
        '```markdown',
        '[a]: ./gone.md',
        '```',
        '`[b]: ./gone.md`',
        '<!--',
        '[c]: ./gone.md',
        '-->',
        '    [d]: ./gone.md',
        '',
      ].join('\n'),
    },
  },
  {
    name: 'lines that look like a label followed by text',
    files: {
      ...guides,
      'shared/rules.md': '[Note]: this is important\n[x]: done and more words\n',
    },
  },
  {
    name: 'a label line whose first word is a missing file',
    files: { ...guides, 'shared/rules.md': '[a]: ./missing.md trailing words\n' },
  },
  {
    name: 'a label line whose first word is a present file',
    files: {
      ...guides,
      'shared/present.md': '# Present\n',
      'shared/rules.md': '[a]: ./present.md trailing words\n',
    },
  },
  {
    name: 'a link target with a query',
    files: {
      ...guides,
      'shared/rules.md': '[a](./coding.md?plain=1) and [b](./coding.md?a=1#coding)\n',
    },
  },
  {
    name: 'a URL target with a query',
    files: { ...guides, 'shared/rules.md': '[a](https://example.com/gone.md?x=1)\n' },
  },
  {
    name: 'an encoded path to a present file',
    files: {
      ...guides,
      'shared/release notes.md': '# Notes\n',
      'shared/coding.md': '[n](./release%20notes.md)\n',
    },
  },
  {
    name: 'a link with an empty fragment',
    files: { ...guides, 'shared/rules.md': '# Rules\n\n[a](./rules.md#)\n' },
  },
  {
    name: 'a fragment on a non-Markdown recorded file',
    files: { ...guides, 'shared/rules.md': '# Rules\n\n[a](./data.txt#anything)\n' },
  },
  {
    name: 'a link target with balanced parentheses',
    files: {
      ...guides,
      'shared/rules(v2).md': '# Rules\n',
      'shared/coding.md': '[rules](./rules(v2).md)\n',
    },
  },
  {
    name: 'a reference definition with the target on the next line',
    files: { ...guides, 'shared/rules.md': '[rules][adr]\n\n[adr]:\n  ./coding.md\n' },
  },
  {
    name: 'a label followed by a blank line and prose',
    files: { ...guides, 'shared/rules.md': '[adr]:\n\n./missing.md\n' },
  },
  {
    name: 'CRLF lines with a present next-line reference target',
    files: {
      ...guides,
      'shared/rules.md':
        '[rules][adr]\r\n\r\n[adr]:\r\n  ./coding.md\r\n[Note]: this is important\r\n',
    },
  },
  {
    name: 'reference definitions with each title form',
    files: {
      ...guides,
      'shared/present.md': '# Present\n',
      'shared/rules.md': [
        '[a]: ./present.md "Title"',
        "[b]: ./present.md 'Title'",
        '[c]: ./present.md (Title) ',
        '',
      ].join('\n'),
    },
  },
  {
    name: 'a fragment to a reference-link heading',
    files: {
      ...guides,
      'shared/rules.md': '# [Rules][r]\n\n[r]: ./coding.md\n',
      'shared/coding.md': `${coding}See [the rules](./rules.md#rules).\n`,
    },
  },
  {
    name: 'an indented code block and an unclosed link',
    files: {
      ...guides,
      'shared/rules.md': '    [x](./gone.md)\n\n[x](./oops.md trailing prose\n',
    },
  },
])('reads $name as valid', async ({ files }) => {
  const result = await readSyncedGuides(writeGuides(files));

  expect(result).toEqual({
    kind: 'valid',
    version: '0.2.0',
    files: new Map(Object.entries(files)),
  });
});

const brokenRows: BrokenRow[] = [
  {
    name: 'a missing record',
    change: (directory) => {
      rmSync(join(directory, recordName));
    },
    reason: [recordName, 'is missing'],
  },
  {
    name: 'a record Tau cannot parse',
    change: (directory) => {
      writeFile(directory, recordName, 'schema = 2\n');
    },
    reason: [recordName, 'uses record schema 2'],
  },
  {
    name: 'an edited file',
    change: (directory) => {
      appendFileSync(join(directory, 'shared/rules.md'), 'More.\n');
    },
    reason: ['shared/rules.md', 'differs'],
  },
  {
    name: 'a missing recorded file',
    change: (directory) => {
      rmSync(join(directory, 'shared/rules.md'));
    },
    reason: ['shared/rules.md', 'is missing'],
  },
  {
    name: 'a symbolic link',
    change: (directory) => {
      writeFile(directory, 'rules-copy.md', rules);
      rmSync(join(directory, 'shared/rules.md'));
      symlinkSync(join(directory, 'rules-copy.md'), join(directory, 'shared/rules.md'));
    },
    reason: ['shared/rules.md', 'symbolic link', 'with the file'],
  },
  {
    name: 'a symbolic link on a parent folder',
    change: (directory) => {
      renameSync(join(directory, 'shared'), join(directory, 'shared-copy'));
      symlinkSync(join(directory, 'shared-copy'), join(directory, 'shared'));
    },
    reason: ['shared', 'symbolic link', 'with the folder'],
  },
  {
    name: 'a symbolic link on the top folder of a nested file',
    files: { 'top/inner/note.md': '# Note\n' },
    change: (directory) => {
      renameSync(join(directory, 'top'), join(directory, 'top-copy'));
      symlinkSync(join(directory, 'top-copy'), join(directory, 'top'));
    },
    reason: ['top is a symbolic link', 'with the folder'],
  },
  {
    name: 'a symbolic link on the inner folder of a nested file',
    files: { 'top/inner/note.md': '# Note\n' },
    change: (directory) => {
      renameSync(join(directory, 'top/inner'), join(directory, 'top/inner-copy'));
      symlinkSync(join(directory, 'top/inner-copy'), join(directory, 'top/inner'));
    },
    reason: ['top/inner is a symbolic link', 'with the folder'],
  },
  {
    name: 'a missing folder of a recorded file',
    change: (directory) => {
      rmSync(join(directory, 'shared'), { recursive: true });
    },
    reason: ['shared/coding.md', 'is missing'],
  },
  {
    name: 'a folder in place of a file',
    change: (directory) => {
      rmSync(join(directory, 'shared/rules.md'));
      mkdirSync(join(directory, 'shared/rules.md'));
    },
    reason: ['shared/rules.md', 'not a file'],
  },
  {
    name: 'a dangling link',
    files: { ...guides, 'shared/rules.md': '[gone](./gone.md)\n' },
    reason: ['shared/rules.md', './gone.md'],
  },
  {
    name: 'a link to a file outside the record',
    files: { ...guides, 'shared/rules.md': '[notes](../notes.md#first)\n' },
    change: (directory) => {
      writeFile(directory, 'notes.md', '# First\n');
    },
    reason: ['shared/rules.md', '../notes.md#first'],
  },
  {
    name: 'a link after a fence inside an HTML comment',
    files: { ...guides, 'shared/rules.md': '<!--\n```markdown\n-->\n[gone](./gone.md)\n' },
    reason: ['shared/rules.md', './gone.md'],
  },
  {
    name: 'a link to the parent folder',
    files: { ...guides, 'shared/rules.md': '[the parent](../..)\n' },
    reason: ['shared/rules.md', 'links to ../..', 'leaves'],
  },
  {
    name: 'a link that leaves the folder',
    files: { ...guides, 'shared/rules.md': '[outside](../../outside.md)\n' },
    reason: ['shared/rules.md', '../../outside.md', 'leaves'],
  },
  {
    name: 'an absolute link',
    files: { ...guides, 'shared/rules.md': '[outside](/shared/coding.md)\n' },
    reason: ['shared/rules.md', '/shared/coding.md', 'leaves'],
  },
  {
    name: 'a dangling reference definition',
    files: { ...guides, 'shared/rules.md': '[rules][adr]\n\n[adr]: ./missing.md\n' },
    reason: ['shared/rules.md', 'links to ./missing.md, which is not a synced file'],
  },
  {
    name: 'a reference definition that leaves the folder',
    files: { ...guides, 'shared/rules.md': '[rules][adr]\n\n  [adr]: ../../outside.md\n' },
    reason: ['shared/rules.md', 'links to ../../outside.md, which leaves the synced folder'],
  },
  {
    name: 'a missing link target with a query',
    files: { ...guides, 'shared/rules.md': '[gone](./gone.md?plain=1)\n' },
    reason: ['shared/rules.md', './gone.md?plain=1', 'not a synced file'],
  },
  {
    name: 'a missing link target with balanced parentheses',
    files: { ...guides, 'shared/rules.md': '[gone](./gone(v2).md)\n' },
    reason: ['shared/rules.md', 'links to ./gone(v2).md, which is not a synced file'],
  },
  {
    name: 'a reference definition with the target on the next line',
    files: { ...guides, 'shared/rules.md': '[rules][adr]\n\n[adr]:\n  ../../outside.md\n' },
    reason: ['shared/rules.md', 'links to ../../outside.md, which leaves the synced folder'],
  },
  {
    name: 'CRLF lines with a next-line reference target that leaves the folder',
    files: {
      ...guides,
      'shared/rules.md': '[rules][adr]\r\n\r\n[adr]:\r\n  ../../outside.md\r\n',
    },
    reason: ['shared/rules.md', 'links to ../../outside.md, which leaves the synced folder'],
  },
  {
    name: 'CRLF lines with an inline link to a missing target',
    files: { ...guides, 'shared/rules.md': '# Rules\r\n\r\n[gone](./gone.md)\r\n' },
    reason: ['shared/rules.md', 'links to ./gone.md, which is not a synced file'],
  },
  {
    name: 'a dangling reference definition after a fenced one',
    files: {
      ...guides,
      'shared/rules.md': '```\n[a]: ./fenced.md\n```\n[b]: <./gone file.md>\n',
    },
    reason: ['shared/rules.md', 'links to ./gone file.md, which is not a synced file'],
  },
  {
    name: 'a dangling reference definition with a title',
    files: { ...guides, 'shared/rules.md': '[rules][adr]\n\n[adr]: ./missing.md "Title"\n' },
    reason: ['shared/rules.md', 'links to ./missing.md, which is not a synced file'],
  },
  {
    name: 'a link to a missing heading in another file',
    files: { ...guides, 'shared/coding.md': '[a](./rules.md#missing)\n' },
    reason: ['links to ./rules.md#missing, which names a missing heading'],
  },
  {
    name: 'a link to a missing heading in the same file',
    files: { ...guides, 'shared/rules.md': '# Rules\n\n[a](#missing)\n' },
    reason: ['links to #missing, which names a missing heading'],
  },
  {
    name: 'an undecodable fragment',
    files: { ...guides, 'shared/rules.md': '# Rules\n\n[a](./rules.md#bad%ZZ)\n' },
    reason: ['links to ./rules.md#bad%ZZ, which names a missing heading'],
  },
  {
    name: 'an encoded path that leaves the folder',
    files: { ...guides, 'shared/rules.md': '[o](./%2E%2E/%2E%2E/outside.md)\n' },
    reason: ['shared/rules.md', './%2E%2E/%2E%2E/outside.md', 'leaves'],
  },
  {
    name: 'an undecodable path',
    files: { ...guides, 'shared/rules.md': '[b](./bad%ZZ.md)\n' },
    reason: ['links to ./bad%ZZ.md, which cannot be decoded'],
  },
  {
    name: 'a reference definition in a blockquote',
    files: { ...guides, 'shared/rules.md': '> [a]: ./gone.md\n' },
    reason: ['links to ./gone.md, which is not a synced file'],
  },
  {
    name: 'a reference definition in a list item',
    files: { ...guides, 'shared/rules.md': '- [a]: ./gone.md\n' },
    reason: ['links to ./gone.md, which is not a synced file'],
  },
  {
    name: 'a missing image target',
    files: { ...guides, 'shared/rules.md': '![alt](./gone.png)\n' },
    reason: ['links to ./gone.png, which is not a synced file'],
  },
  {
    name: 'the first problem in document order',
    files: { ...guides, 'shared/rules.md': '# Rules\n\n[a](./rules.md#nope)\n\n[b]: ./gone.md\n' },
    reason: ['./rules.md#nope'],
  },
];

it.for(brokenRows)('reports $name as broken', async ({ files, change, reason }) => {
  const directory = writeGuides(files ?? guides);

  change?.(directory);

  const result = await readSyncedGuides(directory);

  const found =
    result.kind === 'broken' ? result.reason : `no reason: the result is ${result.kind}`;

  for (const part of reason) {
    expect(found).toContain(part);
  }
});

// The depth that overflows the stack depends on the runner's stack size, so the test deepens the
// quote until the read overflows.
it('reports a guide the tokenizer cannot read as broken', async () => {
  let directory = '';
  let result: SyncedGuides | undefined;

  for (let depth = 1000; depth <= 16_000; depth *= 2) {
    directory = writeGuides({
      ...guides,
      'shared/rules.md': `${'> '.repeat(depth)}[a](./a.md)\n`,
    });

    result = await readSyncedGuides(directory);

    if (result.kind === 'broken' && result.reason.includes('cannot be read as Markdown')) {
      break;
    }
  }

  expect(result).toEqual({
    kind: 'broken',
    reason: `${join(directory, 'shared/rules.md')} cannot be read as Markdown: Maximum call stack size exceeded`,
  });
});

it('reports a synced folder that is a symbolic link as broken', async () => {
  const target = writeGuides(guides);
  const link = `${target}-link`;

  symlinkSync(target, link);

  onTestFinished(() => {
    rmSync(link, { force: true });
  });

  const result = await readSyncedGuides(link);

  expect(result).toEqual({
    kind: 'broken',
    reason: `${link} is a symbolic link; replace it with the folder and run stomme sync`,
  });
});

it('reports a listed folder above the synced folder as broken when it is a symbolic link', async () => {
  const holder = writeGuides({});
  const docs = join(holder, 'docs');

  mkdirSync(join(holder, 'real'));
  renameSync(writeGuides(guides), join(holder, 'real/stomme'));
  symlinkSync(join(holder, 'real'), docs);

  const result = await readSyncedGuides(join(docs, 'stomme'), [docs]);

  expect(result).toEqual({
    kind: 'broken',
    reason: `${docs} is a symbolic link; replace it with the folder and run stomme sync`,
  });
});

it('keeps the missing record reason for a synced folder that does not exist', async () => {
  const directory = join(writeGuides(guides), 'absent');

  const result = await readSyncedGuides(directory);

  expect(result).toEqual({
    kind: 'broken',
    reason: `${join(directory, recordName)} is missing; run stomme sync`,
  });
});

const changingRecord = (versions: readonly string[]): GuideFileSystem => {
  let reads = 0;

  return {
    readFile: () => {
      const version = versions[Math.min(reads, versions.length - 1)] ?? '';

      reads += 1;

      return Promise.resolve(new TextEncoder().encode(recordText(version, {})));
    },
    lstat: () => Promise.reject(new Error('no file is recorded')),
  };
};

it('reports a record that changes while it is read', async () => {
  const result = await readSyncedGuides('guides', [], changingRecord(['1', '2', '3', '4', '5']));

  expect(result).toEqual({
    kind: 'broken',
    reason: expect.stringContaining(recordName) as unknown,
  });
});

it('starts over once when the record changes while it is read', async () => {
  const result = await readSyncedGuides('guides', [], changingRecord(['1', '2']));

  expect(result).toEqual({ kind: 'valid', version: '2', files: new Map() });
});

it('hashes the raw bytes of a recorded file', async () => {
  const directory = writeGuides(guides);
  const bytes = Uint8Array.from([0x23, 0xff, 0xfe]);
  const decoded = new TextDecoder().decode(bytes);

  writeFileSync(join(directory, 'shared/rules.md'), bytes);

  writeFile(directory, recordName, recordText('0.2.0', { ...guides, 'shared/rules.md': decoded }));

  const result = await readSyncedGuides(directory);

  expect(result).toEqual({
    kind: 'broken',
    reason: expect.stringContaining('shared/rules.md differs') as unknown,
  });
});

it('keeps the error of a record that cannot be read again', async () => {
  let reads = 0;

  const fileSystem: GuideFileSystem = {
    readFile: () => {
      reads += 1;

      return reads === 2
        ? Promise.reject(new Error('the disk went away'))
        : Promise.resolve(new TextEncoder().encode(recordText('1', {})));
    },
    lstat: () => Promise.reject(new Error('no file is recorded')),
  };

  const result = await readSyncedGuides('guides', [], fileSystem);
  const reason = result.kind === 'broken' ? result.reason : 'the result is valid';

  expect(reason).toContain('the disk went away');
  expect(reason).toContain('run stomme sync');
});

it('keeps the error of a record that cannot be read at first', async () => {
  let reads = 0;

  const fileSystem: GuideFileSystem = {
    readFile: () => {
      reads += 1;

      return reads === 1
        ? Promise.reject(new Error('the disk went away'))
        : Promise.resolve(new TextEncoder().encode(recordText('1', {})));
    },
    lstat: () => Promise.reject(new Error('no file is recorded')),
  };

  const result = await readSyncedGuides('guides', [], fileSystem);
  const reason = result.kind === 'broken' ? result.reason : 'the result is valid';

  expect(reason).toContain('the disk went away');
});

it('keeps the byte order mark in the text of a guide', async () => {
  const text = '\uFEFF# Heading\n';
  const directory = writeGuides({ ...guides, 'shared/rules.md': text });

  const result = await readSyncedGuides(directory);
  const found = result.kind === 'valid' ? result.files.get('shared/rules.md') : undefined;

  expect(found).toBe(text);
});

it('reports a named pipe in place of the record as broken instead of waiting for a writer', async () => {
  const directory = writeGuides(guides);
  const recordFile = join(directory, recordName);

  rmSync(recordFile);
  await promisify(execFile)('mkfifo', [recordFile]);

  // A reader that opens a named pipe waits for a writer. Opening it for writing ends a stuck read.
  onTestFinished(() => {
    closeSync(openSync(recordFile, 'r+'));
  });

  const result = await readSyncedGuides(directory);

  expect(result).toEqual({
    kind: 'broken',
    reason: `${recordFile} cannot be read: it is not a regular file; run stomme sync`,
  });
}, 2000);
