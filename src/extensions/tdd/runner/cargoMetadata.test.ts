import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { parseCargoMetadata } from './cargoMetadata.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

it('reads the workspace root and every package target kind', () => {
  expect(parseCargoMetadata(fixture('cargoMetadata.json'))).toEqual({
    workspaceRoot: '/workspace',
    targets: [{ kinds: ['lib'] }, { kinds: ['bin'] }, { kinds: ['test'] }, { kinds: ['lib'] }],
  });
});

it.for([
  { name: 'empty text', stdout: '' },
  { name: 'truncated JSON', stdout: '{"workspace_root":"/workspace"' },
  { name: 'a JSON array', stdout: '[]' },
  { name: 'an object without packages', stdout: '{"workspace_root":"/workspace"}' },
  { name: 'an object without a workspace root', stdout: '{"packages":[]}' },
  {
    name: 'a package whose targets are not an array',
    stdout: '{"workspace_root":"/workspace","packages":[{"id":"p","targets":{}}]}',
  },
  {
    name: 'a target without a kind',
    stdout: '{"workspace_root":"/workspace","packages":[{"id":"p","targets":[{"name":"demo"}]}]}',
  },
  {
    name: 'a target whose kind holds a non-string',
    stdout:
      '{"workspace_root":"/workspace","packages":[{"id":"p","targets":[{"name":"demo","kind":[1],"src_path":"/w/src/lib.rs"}]}]}',
  },
])('returns null for $name', ({ stdout }) => {
  expect(parseCargoMetadata(stdout)).toBeNull();
});
