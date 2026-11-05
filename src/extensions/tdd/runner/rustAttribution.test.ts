import { expect, it } from 'vitest';

import { attributeRustResult } from './rustAttribution.js';
import type { AttributionRequest, RustBinarySources } from './rustAttribution.js';

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
  request: AttributionRequest;
  expected: Record<string, unknown>;
}>([
  {
    name: 'exact for one requested file',
    request: {
      result: { binaryId: 'demo', fullname: 'sub::tests::fails' },
      binaries: [
        binary('demo', {
          sources: ['src/lib.rs', 'src/sub.rs'],
          testNames: ['sub::tests::fails'],
        }),
      ],
      requestedFiles: ['src/sub.rs'],
    },
    expected: { kind: 'exact', file: 'src/sub.rs' },
  },
  {
    name: 'exact beside unrequested files',
    request: {
      result: { binaryId: 'demo', fullname: 'sub::tests::fails' },
      binaries: [
        binary('demo', {
          sources: ['src/lib.rs', 'src/sub.rs', 'src/other.rs'],
          testNames: ['sub::tests::fails'],
        }),
      ],
      requestedFiles: ['src/sub.rs'],
    },
    expected: { kind: 'exact', file: 'src/sub.rs' },
  },
  {
    name: 'ambiguous for several files',
    request: {
      result: { binaryId: 'demo', fullname: 'tests::fails' },
      binaries: [
        binary('demo', {
          sources: ['src/a.rs', 'src/b.rs', 'src/c.rs'],
          testNames: ['tests::fails'],
        }),
      ],
      requestedFiles: ['src/a.rs', 'src/b.rs'],
    },
    expected: { kind: 'ambiguous', binaryIds: ['demo'], files: ['src/a.rs', 'src/b.rs'] },
  },
  {
    name: 'ambiguous for a name in two binaries',
    request: {
      result: { binaryId: 'demo', fullname: 'shared::fails' },
      binaries: [
        binary('demo', { sources: ['src/shared.rs'], testNames: ['shared::fails'] }),
        binary('demo::bin/demo', {
          sources: ['src/shared.rs'],
          testNames: ['shared::fails'],
        }),
      ],
      requestedFiles: ['src/shared.rs'],
    },
    expected: { kind: 'ambiguous', binaryIds: ['demo', 'demo::bin/demo'] },
  },
  {
    name: 'ambiguous for a name in two files',
    request: {
      result: { binaryId: 'demo', fullname: 'shared_fails' },
      binaries: [
        binary('demo', { sources: ['src/lib.rs'], testNames: ['shared_fails'] }),
        binary('demo::bin/demo', {
          sources: ['src/main.rs'],
          testNames: ['shared_fails'],
        }),
      ],
      requestedFiles: ['src/lib.rs'],
    },
    expected: { kind: 'ambiguous', binaryIds: ['demo', 'demo::bin/demo'] },
  },
  {
    name: 'ambiguous for several files and names',
    request: {
      result: { binaryId: 'demo', fullname: 'shared_fails' },
      binaries: [
        binary('demo', {
          sources: ['src/lib.rs', 'src/sub.rs'],
          testNames: ['shared_fails'],
        }),
        binary('demo::bin/demo', { sources: ['src/main.rs'], testNames: ['shared_fails'] }),
      ],
      requestedFiles: ['src/lib.rs', 'src/sub.rs'],
    },
    expected: {
      kind: 'ambiguous',
      binaryIds: ['demo', 'demo::bin/demo'],
      files: ['src/lib.rs', 'src/sub.rs'],
    },
  },
  {
    name: 'unknown for no requested file',
    request: {
      result: { binaryId: 'demo', fullname: 'sub::fails' },
      binaries: [binary('demo', { sources: ['src/lib.rs'], testNames: ['sub::fails'] })],
      requestedFiles: ['src/sub.rs'],
    },
    expected: { kind: 'unknown' },
  },
  {
    name: 'unknown for missing dep-info',
    request: {
      result: { binaryId: 'demo', fullname: 'sub::fails' },
      binaries: [binary('demo', { sources: null, testNames: ['sub::fails'] })],
      requestedFiles: ['src/sub.rs'],
    },
    expected: { kind: 'unknown', reason: 'no dep-info for binary demo' },
  },
  {
    name: 'unknown for stale dep-info',
    request: {
      result: { binaryId: 'demo', fullname: 'sub::fails' },
      binaries: [binary('demo', { sources: ['src/lib.rs'], testNames: ['sub::fails'] })],
      requestedFiles: ['src/sub.rs'],
    },
    expected: { kind: 'unknown' },
  },
  {
    name: 'unknown for an unlisted binary',
    request: {
      result: { binaryId: 'missing', fullname: 'sub::fails' },
      binaries: [binary('demo', { sources: ['src/lib.rs'] })],
      requestedFiles: ['src/sub.rs'],
    },
    expected: { kind: 'unknown', reason: 'no binary named missing' },
  },
])('attributes $name', ({ request, expected }) => {
  expect(attributeRustResult(request)).toMatchObject(expected);
});
