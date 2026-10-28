import { expect, it } from 'vitest';

import { decideEndpoint } from './endpointDecision.js';
import type { EligibilityFacts, SnapshotFacts } from './endpointDecision.js';

const snapshot = (facts: Partial<SnapshotFacts>): SnapshotFacts => ({
  skipped: [],
  shownModes: [],
  presentModes: [{ path: 'a.ts', mode: '100644' }],
  ...facts,
});

const facts = (given: Partial<EligibilityFacts>): EligibilityFacts => ({
  target: 'workingTree',
  chainedFix: false,
  gaps: [],
  snapshot: snapshot({}),
  ...given,
});

const skipped = (kind: 'binary' | 'unreadable' | 'submodule', path: string) => ({
  kind,
  path,
  identity: null,
  existed: true,
});

it.each([
  { name: 'a range', facts: facts({ target: 'range', snapshot: undefined }) },
  {
    name: 'a chained fix',
    facts: facts({ target: 'fix', chainedFix: true, snapshot: undefined }),
  },
  {
    name: 'a working tree of supported modes',
    facts: facts({ snapshot: snapshot({ shownModes: [{ path: 'a.ts', mode: '100755' }] }) }),
  },
] satisfies { name: string; facts: EligibilityFacts }[])(
  'decides that $name can record a complete endpoint',
  ({ facts: given }) => {
    expect(decideEndpoint(given)).toEqual({ status: 'eligible' });
  },
);

it.each([
  { name: 'a files target', facts: facts({ target: 'files' }), reasons: ['files capture'] },
  { name: 'a root commit target', facts: facts({ target: 'rootCommit' }), reasons: ['rootCommit'] },
  { name: 'a fix target', facts: facts({ target: 'fix' }), reasons: ['no complete endpoint'] },
  {
    name: 'a chained fix with a binary gap',
    facts: facts({
      target: 'fix',
      chainedFix: true,
      snapshot: undefined,
      gaps: [{ kind: 'binary', path: 'a.bin' }],
    }),
    reasons: ['a.bin (binary)'],
  },
  {
    name: 'a range with an excluded gap',
    facts: facts({ target: 'range', gaps: [{ kind: 'excluded', path: 'b.ts' }] }),
    reasons: ['b.ts (excluded)'],
  },
  {
    name: 'an unreadable gap beside a binary gap',
    facts: facts({
      gaps: [
        { kind: 'unreadable', path: 'secret.txt' },
        { kind: 'binary', path: 'image.bin' },
      ],
    }),
    reasons: ['secret.txt (unreadable)', 'image.bin (binary)'],
  },
  {
    name: 'a skipped binary file',
    facts: facts({ snapshot: snapshot({ skipped: [skipped('binary', 'a.bin')] }) }),
    reasons: ['skipped a.bin (binary)'],
  },
  {
    name: 'a skipped submodule',
    facts: facts({ snapshot: snapshot({ skipped: [skipped('submodule', 'module')] }) }),
    reasons: ['skipped module (submodule)'],
  },
  {
    name: 'a shown symbolic link',
    facts: facts({ snapshot: snapshot({ shownModes: [{ path: 'link', mode: 'symlink' }] }) }),
    reasons: ['link is a symbolic link'],
  },
  {
    name: 'a shown submodule',
    facts: facts({ snapshot: snapshot({ shownModes: [{ path: 'module', mode: 'gitlink' }] }) }),
    reasons: ['module is a submodule'],
  },
  {
    name: 'a shown mode Tau cannot read',
    facts: facts({ snapshot: snapshot({ shownModes: [{ path: 'odd', mode: 'unreadable' }] }) }),
    reasons: ['mode for odd that Tau cannot read'],
  },
  {
    name: 'a present path with no mode',
    facts: facts({ snapshot: snapshot({ presentModes: [{ path: 'a.ts', mode: undefined }] }) }),
    reasons: ['shows a mode for a.ts'],
  },
  {
    name: 'a skipped unreadable and binary file',
    facts: facts({
      snapshot: snapshot({
        skipped: [skipped('unreadable', 'secret.txt'), skipped('binary', 'a.bin')],
      }),
    }),
    reasons: ['skipped a.bin (binary)', 'skipped secret.txt (unreadable)'],
  },
] satisfies { name: string; facts: EligibilityFacts; reasons: string[] }[])(
  'reports $name as unsupported',
  ({ facts: given, reasons }) => {
    const expected = reasons.map((reason) => expect.stringContaining(reason) as string);

    expect(decideEndpoint(given)).toEqual({ status: 'unsupported', reasons: expected });
  },
);

it.each([
  {
    name: 'an unreadable gap',
    facts: facts({ gaps: [{ kind: 'unreadable', path: 'secret.txt' }] }),
    reasons: ['secret.txt (unreadable)'],
  },
  {
    name: 'a working tree that saved no snapshot',
    facts: facts({ snapshot: undefined }),
    reasons: ['saved no snapshot'],
  },
  {
    name: 'a skipped unreadable file',
    facts: facts({ snapshot: snapshot({ skipped: [skipped('unreadable', 'secret.txt')] }) }),
    reasons: ['skipped secret.txt (unreadable)'],
  },
] satisfies { name: string; facts: EligibilityFacts; reasons: string[] }[])(
  'reports $name as incomplete',
  ({ facts: given, reasons }) => {
    const expected = reasons.map((reason) => expect.stringContaining(reason) as string);

    expect(decideEndpoint(given)).toEqual({ status: 'incomplete', reasons: expected });
  },
);
