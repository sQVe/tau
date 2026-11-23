import { expect, it } from 'vitest';

import { checkGuideLinks } from './guideLinks.js';
import type { GuideLinkCheck } from './guideLinks.js';

const table: {
  name: string;
  files: [string, string][];
  expected: GuideLinkCheck;
}[] = [
  {
    name: 'an anchor in the same file',
    files: [['shared/coding.md', '# Coding\n\nSee [the top](#coding).\n']],
    expected: { kind: 'valid' },
  },
  {
    name: 'a URL target with a query',
    files: [['shared/rules.md', '[a](https://example.com/gone.md?x=1)\n']],
    expected: { kind: 'valid' },
  },
  {
    name: 'a link target with a query',
    files: [
      ['shared/rules.md', '# Rules\n'],
      ['shared/coding.md', '[a](./rules.md?plain=1) and [b](./rules.md?a=1#rules)\n'],
    ],
    expected: { kind: 'valid' },
  },
  {
    name: 'an encoded path to a present file',
    files: [
      ['shared/release notes.md', '# Notes\n'],
      ['shared/coding.md', '[n](./release%20notes.md)\n'],
    ],
    expected: { kind: 'valid' },
  },
  {
    name: 'a fragment to a heading in another file',
    files: [
      ['shared/rules.md', '# Rules\n'],
      ['shared/coding.md', '[the rules](./rules.md#rules)\n'],
    ],
    expected: { kind: 'valid' },
  },
  {
    name: 'a fragment to a reference-link heading',
    files: [
      ['shared/rules.md', '# [Rules][r]\n\n[r]: ./coding.md\n'],
      ['shared/coding.md', '# Coding\n\n[the rules](./rules.md#rules)\n'],
    ],
    expected: { kind: 'valid' },
  },
  {
    name: 'a link to a non-Markdown file',
    files: [
      ['shared/data.txt', '[not Markdown](./gone.md)\n'],
      ['shared/coding.md', '[data](./data.txt)\n'],
    ],
    expected: { kind: 'valid' },
  },
  {
    name: 'a fragment on a non-Markdown file',
    files: [
      ['shared/data.txt', 'text\n'],
      ['shared/coding.md', '[a](./data.txt#anything)\n'],
    ],
    expected: { kind: 'valid' },
  },
  {
    name: 'a link with an empty fragment',
    files: [['shared/rules.md', '# Rules\n\n[a](./rules.md#)\n']],
    expected: { kind: 'valid' },
  },
  {
    name: 'a link target with balanced parentheses',
    files: [
      ['shared/rules(v2).md', '# Rules\n'],
      ['shared/coding.md', '[rules](./rules(v2).md)\n'],
    ],
    expected: { kind: 'valid' },
  },
  {
    name: 'a link target in angle brackets with a space',
    files: [
      ['shared/a b.md', '# A\n'],
      ['shared/rules.md', '[space](<./a b.md>)\n'],
    ],
    expected: { kind: 'valid' },
  },
  {
    name: 'a dangling link',
    files: [['shared/rules.md', '[gone](./gone.md)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      problem: 'links to ./gone.md, which is not a synced file',
    },
  },
  {
    name: 'a link to a file outside the record',
    files: [['shared/rules.md', '[notes](../notes.md#first)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      problem: 'links to ../notes.md#first, which is not a synced file',
    },
  },
  {
    name: 'a link to the parent folder',
    files: [['shared/rules.md', '[the parent](../..)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      problem: 'links to ../.., which leaves the synced folder',
    },
  },
  {
    name: 'a link that leaves the folder',
    files: [['shared/rules.md', '[outside](../../outside.md)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      problem: 'links to ../../outside.md, which leaves the synced folder',
    },
  },
  {
    name: 'an absolute link',
    files: [['shared/rules.md', '[outside](/shared/coding.md)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      problem: 'links to /shared/coding.md, which leaves the synced folder',
    },
  },
  {
    name: 'an encoded path that leaves the folder',
    files: [['shared/rules.md', '[o](./%2E%2E/%2E%2E/outside.md)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      problem: 'links to ./%2E%2E/%2E%2E/outside.md, which leaves the synced folder',
    },
  },
  {
    name: 'an undecodable path',
    files: [['shared/rules.md', '[b](./bad%ZZ.md)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      problem: 'links to ./bad%ZZ.md, which cannot be decoded',
    },
  },
  {
    name: 'a link to a missing heading in another file',
    files: [
      ['shared/rules.md', '# Rules\n'],
      ['shared/coding.md', '[a](./rules.md#missing)\n'],
    ],
    expected: {
      kind: 'broken',
      path: 'shared/coding.md',
      problem: 'links to ./rules.md#missing, which names a missing heading',
    },
  },
  {
    name: 'a link to a missing heading in the same file',
    files: [['shared/rules.md', '# Rules\n\n[a](#missing)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      problem: 'links to #missing, which names a missing heading',
    },
  },
  {
    name: 'an undecodable fragment',
    files: [['shared/rules.md', '# Rules\n\n[a](./rules.md#bad%ZZ)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      problem: 'links to ./rules.md#bad%ZZ, which names a missing heading',
    },
  },
  {
    name: 'a missing image target',
    files: [['shared/rules.md', '![alt](./gone.png)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      problem: 'links to ./gone.png, which is not a synced file',
    },
  },
  {
    name: 'a missing link target with a query',
    files: [['shared/rules.md', '[gone](./gone.md?plain=1)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      problem: 'links to ./gone.md?plain=1, which is not a synced file',
    },
  },
  {
    name: 'a missing link target with balanced parentheses',
    files: [['shared/rules.md', '[gone](./gone(v2).md)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      problem: 'links to ./gone(v2).md, which is not a synced file',
    },
  },
  {
    name: 'a dangling reference definition',
    files: [['shared/rules.md', '[rules][adr]\n\n[adr]: ./missing.md\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      problem: 'links to ./missing.md, which is not a synced file',
    },
  },
  {
    name: 'a reference definition that leaves the folder',
    files: [['shared/rules.md', '[rules][adr]\n\n  [adr]: ../../outside.md\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      problem: 'links to ../../outside.md, which leaves the synced folder',
    },
  },
  {
    name: 'the first problem in document order',
    files: [['shared/rules.md', '# Rules\n\n[a](./rules.md#nope)\n\n[b]: ./gone.md\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      problem: 'links to ./rules.md#nope, which names a missing heading',
    },
  },
  {
    name: 'two broken files report the first in record order',
    files: [
      ['z.md', '[a](./gone-z.md)\n'],
      ['a.md', '[b](./gone-a.md)\n'],
    ],
    expected: {
      kind: 'broken',
      path: 'z.md',
      problem: 'links to ./gone-z.md, which is not a synced file',
    },
  },
  {
    name: 'decodes a fragment before the heading lookup',
    files: [
      ['rules.md', '# Read me\n'],
      ['coding.md', '[r](./rules.md#read%2Dme)\n'],
    ],
    expected: { kind: 'valid' },
  },
  {
    name: 'a link to a heading in a later file',
    files: [
      ['a.md', '[b](./b.md#later)\n'],
      ['b.md', '# Later\n'],
    ],
    expected: { kind: 'valid' },
  },
];

it.for(table)('$name', ({ files, expected }) => {
  expect(checkGuideLinks(new Map(files))).toEqual(expected);
});
