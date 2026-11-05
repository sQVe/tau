import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { parseRustDepInfo } from './rustDepInfo.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

it.for<{ name: string; text: string; sources: string[] }>([
  {
    name: 'a lib binary',
    text: fixture('rustDepInfo.lib.d'),
    sources: [
      'src/lib.rs',
      'src/sub.rs',
      'src/with space.rs',
      'src/dollar$.rs',
      'src/double$$.rs',
      'src/hash#name.rs',
      '/workspace/external/ext.rs',
    ],
  },
  {
    name: 'a bin binary',
    text: fixture('rustDepInfo.bin.d'),
    sources: ['src/bin/tool.rs'],
  },
  {
    name: 'an integration test binary',
    text: fixture('rustDepInfo.test.d'),
    sources: ['tests/nested/main.rs'],
  },
])('parses $name dep-info into its source paths', ({ text, sources }) => {
  expect(parseRustDepInfo(text)).toEqual(sources);
});

it.for<{ name: string; text: string }>([
  { name: 'empty text', text: '' },
  { name: 'text without a rule', text: 'src/lib.rs src/sub.rs' },
  { name: 'a rule without sources', text: '/workspace/demo.d:' },
  { name: 'an empty source list', text: '/workspace/demo.d: ' },
  { name: 'only per-source rules', text: 'src/lib.rs:\nsrc/sub.rs:\n' },
])('returns null for $name', ({ text }) => {
  expect(parseRustDepInfo(text)).toBeNull();
});
