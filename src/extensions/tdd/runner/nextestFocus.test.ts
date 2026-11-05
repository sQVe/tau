import { expect, it } from 'vitest';

import { planFocus } from './nextestFocus.js';
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
