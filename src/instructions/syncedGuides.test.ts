import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
    reason: ['shared/rules.md', 'symbolic link'],
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
    name: 'a link that leaves the folder',
    files: { ...guides, 'shared/rules.md': '[outside](../../outside.md)\n' },
    reason: ['shared/rules.md', '../../outside.md', 'leaves'],
  },
  {
    name: 'an absolute link',
    files: { ...guides, 'shared/rules.md': '[outside](/shared/coding.md)\n' },
    reason: ['shared/rules.md', '/shared/coding.md', 'leaves'],
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

// Returns the next text on each read of the record, and repeats the last one.
const changingRecord = (versions: readonly string[]): GuideFileSystem => {
  let reads = 0;

  return {
    readFile: () => {
      const version = versions[Math.min(reads, versions.length - 1)] ?? '';

      reads += 1;

      return Promise.resolve(recordText(version, {}));
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
