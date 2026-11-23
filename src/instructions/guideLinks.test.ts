import { expect, it } from 'vitest';

import { checkGuideLinks } from './guideLinks.js';
import type { GuideLinkCheck } from './guideLinks.js';

// The Markdown lexer recurses once per blockquote level, so this depth overflows the stack.
const unreadableMarkdown = `${'> '.repeat(16_000)}[a](./b.md)\n`;

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
    name: 'a dangling link',
    files: [['shared/rules.md', '[gone](./gone.md)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      target: './gone.md',
      problem: 'not-synced',
    },
  },
  {
    name: 'a link to a file outside the record',
    files: [['shared/rules.md', '[notes](../notes.md#first)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      target: '../notes.md#first',
      problem: 'not-synced',
    },
  },
  {
    name: 'a link to the parent folder',
    files: [['shared/rules.md', '[the parent](../..)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      target: '../..',
      problem: 'leaves-folder',
    },
  },
  {
    name: 'a link that leaves the folder',
    files: [['shared/rules.md', '[outside](../../outside.md)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      target: '../../outside.md',
      problem: 'leaves-folder',
    },
  },
  {
    name: 'an absolute link',
    files: [['shared/rules.md', '[outside](/shared/coding.md)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      target: '/shared/coding.md',
      problem: 'leaves-folder',
    },
  },
  {
    name: 'an encoded path that leaves the folder',
    files: [['shared/rules.md', '[o](./%2E%2E/%2E%2E/outside.md)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      target: './%2E%2E/%2E%2E/outside.md',
      problem: 'leaves-folder',
    },
  },
  {
    name: 'an undecodable path',
    files: [['shared/rules.md', '[b](./bad%ZZ.md)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      target: './bad%ZZ.md',
      problem: 'undecodable',
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
      target: './rules.md#missing',
      problem: 'missing-heading',
    },
  },
  {
    name: 'a link to a missing heading in the same file',
    files: [['shared/rules.md', '# Rules\n\n[a](#missing)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      target: '#missing',
      problem: 'missing-heading',
    },
  },
  {
    name: 'an undecodable fragment',
    files: [['shared/rules.md', '# Rules\n\n[a](./rules.md#bad%ZZ)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      target: './rules.md#bad%ZZ',
      problem: 'undecodable',
    },
  },
  {
    name: 'an undecodable fragment before an unreadable later file',
    files: [
      ['a.md', '[b](./b.md#bad%ZZ)\n'],
      ['b.md', unreadableMarkdown],
    ],
    expected: {
      kind: 'broken',
      path: 'a.md',
      target: './b.md#bad%ZZ',
      problem: 'undecodable',
    },
  },
  {
    name: 'a missing link target with a query',
    files: [['shared/rules.md', '[gone](./gone.md?plain=1)\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      target: './gone.md?plain=1',
      problem: 'not-synced',
    },
  },
  {
    name: 'the first problem in document order',
    files: [['shared/rules.md', '# Rules\n\n[a](./rules.md#nope)\n\n[b]: ./gone.md\n']],
    expected: {
      kind: 'broken',
      path: 'shared/rules.md',
      target: './rules.md#nope',
      problem: 'missing-heading',
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
      target: './gone-z.md',
      problem: 'not-synced',
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
  {
    name: 'reports a nested image before its link',
    files: [['a.md', '[![Badge](./badge.png)](./page.md)\n']],
    expected: {
      kind: 'broken',
      path: 'a.md',
      target: './badge.png',
      problem: 'not-synced',
    },
  },
  {
    name: 'checks a reference use at its definition',
    files: [['a.md', '[r][a] [i](./inline.md)\n\n[a]: ./definition.md\n']],
    expected: {
      kind: 'broken',
      path: 'a.md',
      target: './inline.md',
      problem: 'not-synced',
    },
  },
];

it.for(table)('$name', ({ files, expected }) => {
  expect(checkGuideLinks(new Map(files))).toEqual(expected);
});
