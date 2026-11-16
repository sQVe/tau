import { expect, it } from 'vitest';

import { planAffectedFocus, planFocus, planForScope } from './nextestFocus.js';
import type { FocusPlan } from './nextestFocus.js';
import type { RustBinarySources } from './rustAttribution.js';

const binary = (
  binaryId: string,
  overrides: Partial<RustBinarySources> = {},
): RustBinarySources => ({
  binaryId,
  sources: ['src/lib.rs'],
  testNames: [],
  ...overrides,
});

it.for<{
  name: string;
  binaries: RustBinarySources[];
  requestedFiles: string[];
  expected: FocusPlan;
}>([
  {
    name: 'scopes to the one binary that contains the requested file',
    binaries: [binary('demo', { sources: ['src/lib.rs', 'src/sub.rs'] })],
    requestedFiles: ['src/sub.rs'],
    expected: { kind: 'scoped', binaryIds: ['demo'] },
  },
  {
    name: 'scopes to every binary that contains the requested file',
    binaries: [
      binary('demo', { sources: ['src/lib.rs', 'src/sub.rs'] }),
      binary('demo::bin/tool', { sources: ['src/main.rs', 'src/sub.rs'] }),
    ],
    requestedFiles: ['src/sub.rs'],
    expected: { kind: 'scoped', binaryIds: ['demo', 'demo::bin/tool'] },
  },
  {
    name: 'scopes to the union of the binaries for several requested files',
    binaries: [
      binary('demo', { sources: ['src/lib.rs', 'src/sub.rs'] }),
      binary('demo::nested', { sources: ['tests/nested/main.rs'] }),
    ],
    requestedFiles: ['src/sub.rs', 'tests/nested/main.rs'],
    expected: { kind: 'scoped', binaryIds: ['demo', 'demo::nested'] },
  },
  {
    name: 'collects no tests when no binary contains a requested file',
    binaries: [binary('demo', { sources: ['src/lib.rs'] })],
    requestedFiles: ['src/other.rs'],
    expected: { kind: 'collect-none' },
  },
  {
    name: 'keeps a matched binary when another requested file matches none',
    binaries: [binary('demo', { sources: ['src/lib.rs'] })],
    requestedFiles: ['src/lib.rs', 'src/platform.rs'],
    expected: { kind: 'scoped', binaryIds: ['demo'] },
  },
  {
    name: 'stays unscoped when any binary has no dep-info',
    binaries: [
      binary('demo', { sources: ['src/lib.rs', 'src/sub.rs'] }),
      binary('other', { sources: null }),
    ],
    requestedFiles: ['src/sub.rs'],
    expected: { kind: 'unscoped' },
  },
  {
    name: 'stays unscoped without requested files',
    binaries: [binary('demo', { sources: ['src/lib.rs'] })],
    requestedFiles: [],
    expected: { kind: 'unscoped' },
  },
])('plans focus for $name', ({ binaries, requestedFiles, expected }) => {
  expect(planFocus(binaries, requestedFiles)).toEqual(expected);
});

it.for<{
  name: string;
  binaries: RustBinarySources[];
  requestedFiles: string[];
  expected: FocusPlan;
}>([
  {
    name: 'scopes to the binaries for the non-blank requested files',
    binaries: [
      binary('demo', { sources: ['src/lib.rs', 'src/sub.rs'] }),
      binary('other', { sources: ['src/other.rs'] }),
    ],
    requestedFiles: ['', 'src/sub.rs', '   '],
    expected: { kind: 'scoped', binaryIds: ['demo'] },
  },
  {
    name: 'collects no tests when every requested file is blank',
    binaries: [binary('demo', { sources: ['src/lib.rs'] })],
    requestedFiles: ['', '  '],
    expected: { kind: 'collect-none' },
  },
  {
    name: 'collects no tests when no binary contains a requested file',
    binaries: [binary('demo', { sources: ['src/lib.rs'] })],
    requestedFiles: ['src/other.rs'],
    expected: { kind: 'collect-none' },
  },
  {
    name: 'stays unscoped when any binary has no dep-info',
    binaries: [binary('demo', { sources: null })],
    requestedFiles: ['src/lib.rs'],
    expected: { kind: 'unscoped' },
  },
])('plans affected focus for $name', ({ binaries, requestedFiles, expected }) => {
  expect(planAffectedFocus(binaries, requestedFiles)).toEqual(expected);
});

it.for<{
  name: string;
  scope: 'focused' | 'affected' | 'full';
  requestedFiles: string[];
  expected: FocusPlan;
}>([
  {
    name: 'full ignores requested files',
    scope: 'full',
    requestedFiles: ['src/sub.rs'],
    expected: { kind: 'unscoped' },
  },
  {
    name: 'focused without files is unscoped',
    scope: 'focused',
    requestedFiles: [],
    expected: { kind: 'unscoped' },
  },
  {
    name: 'affected without files collects none',
    scope: 'affected',
    requestedFiles: [],
    expected: { kind: 'collect-none' },
  },
  {
    name: 'affected scopes to the binary',
    scope: 'affected',
    requestedFiles: ['src/sub.rs'],
    expected: { kind: 'scoped', binaryIds: ['demo'] },
  },
])('plans by scope: $name', ({ scope, requestedFiles, expected }) => {
  const binaries = [binary('demo', { sources: ['src/lib.rs', 'src/sub.rs'] })];

  expect(planForScope(scope, binaries, requestedFiles)).toEqual(expected);
});
