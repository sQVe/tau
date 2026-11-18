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
import type { GuideFileSystem } from './syncedGuides.js';

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
  'See [the rules](./rules.md), [a heading](./rules.md#rules), and [the top](#coding).',
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
        '[a]: https://example.com/gone.md\n[b]: #rules\n[c]: ./coding.md#top\n[^1]: A note.\n',
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
    name: 'a dangling reference definition after a fenced one',
    files: {
      ...guides,
      'shared/rules.md': '```\n[a]: ./fenced.md\n```\n[b]: <./gone file.md>\n',
    },
    reason: ['shared/rules.md', 'links to ./gone file.md, which is not a synced file'],
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
  const result = await readSyncedGuides('guides', changingRecord(['1', '2', '3', '4', '5']));

  expect(result).toEqual({
    kind: 'broken',
    reason: expect.stringContaining(recordName) as unknown,
  });
});

it('starts over once when the record changes while it is read', async () => {
  const result = await readSyncedGuides('guides', changingRecord(['1', '2']));

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

  const result = await readSyncedGuides('guides', fileSystem);
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

  const result = await readSyncedGuides('guides', fileSystem);
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
