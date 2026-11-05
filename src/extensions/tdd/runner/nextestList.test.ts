import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { parseNextestList } from './nextestList.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

it('reads every binary and its discovered test names from rust-suites', () => {
  expect(parseNextestList(fixture('nextestList.json'))).toEqual({
    binaries: [
      {
        binaryId: 'member',
        binaryName: 'member',
        kind: 'lib',
        binaryPath: '/workspace/target/debug/deps/member-99c961402645c91b',
        packageId: 'path+file:///workspace/crates/member#0.1.0',
        cwd: '/workspace/crates/member',
        testNames: ['sub::tests::fails', 'sub::tests::passes', 'tests::lib_adds'],
      },
      {
        binaryId: 'member::nested',
        binaryName: 'nested',
        kind: 'test',
        binaryPath: '/workspace/target/debug/deps/nested-9edaf2a5e75abd64',
        packageId: 'path+file:///workspace/crates/member#0.1.0',
        cwd: '/workspace/crates/member',
        testNames: ['integration_passes'],
      },
      {
        binaryId: 'member::bin/tool',
        binaryName: 'tool',
        kind: 'bin',
        binaryPath: '/workspace/target/debug/deps/tool-ffd382ccd30df933',
        packageId: 'path+file:///workspace/crates/member#0.1.0',
        cwd: '/workspace/crates/member',
        testNames: [],
      },
      {
        binaryId: 'other',
        binaryName: 'other',
        kind: 'lib',
        binaryPath: '/workspace/target/debug/deps/other-aec183b1674b0048',
        packageId: 'path+file:///workspace/crates/other#0.1.0',
        cwd: '/workspace/crates/other',
        testNames: ['other_test'],
      },
    ],
  });
});

it.for([
  { name: 'empty text', stdout: '' },
  { name: 'truncated JSON', stdout: '{"rust-suites":{"demo":{"binary-id":"demo"' },
  { name: 'a JSON array', stdout: '[]' },
  { name: 'an object without rust-suites', stdout: '{"test-count":1}' },
  { name: 'rust-suites that is not an object', stdout: '{"rust-suites":[]}' },
  {
    name: 'a suite without a binary path',
    stdout:
      '{"rust-suites":{"demo":{"binary-id":"demo","binary-name":"demo","kind":"lib","package-id":"p","cwd":"/repo","testcases":{}}}}',
  },
  {
    name: 'a suite whose testcases are not an object',
    stdout:
      '{"rust-suites":{"demo":{"binary-id":"demo","binary-name":"demo","kind":"lib","binary-path":"/b","package-id":"p","cwd":"/repo","testcases":[]}}}',
  },
])('returns null for $name', ({ stdout }) => {
  expect(parseNextestList(stdout)).toBeNull();
});
