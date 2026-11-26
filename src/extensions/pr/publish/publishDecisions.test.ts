import { array, assert, integer, property } from 'fast-check';
import { expect, it } from 'vitest';

import { resolvePropertySeed } from '../../../../tests/propertySeedHarness.ts';
import { decidePublication, publicationToken } from './publishDecisions.js';
import type {
  PublicationDecision,
  PublicationFile,
  PublicationTargetFacts,
} from './publishDecisions.js';

const title: PublicationFile = { file: 'title.md', bytes: Buffer.from('Add a feature\n') };
const body: PublicationFile = { file: 'body.md', bytes: Buffer.from('Adds it.\n') };
const files = [title, body];

const target: PublicationTargetFacts = {
  kind: 'pullRequest',
  repository: 'github.com/sQVe/tau',
  directory: '/repo/.tau/pr/run-1',
  pr: 7,
};

const token = publicationToken(target, files);

const createTarget: PublicationTargetFacts = {
  kind: 'pullRequest',
  repository: 'github.com/sQVe/tau',
  directory: '/repo/.tau/pr/run-1',
  base: 'main',
  head: 'feature',
  draft: false,
};

const createToken = publicationToken(createTarget, files);

const refusal = (reason: string): PublicationDecision => ({ kind: 'refuse', reason });

const targetRefusal = refusal(
  'The token covers a different publication target. Nothing was published. Run dryRun again.',
);

const table: {
  name: string;
  facts: { token: string; target: PublicationTargetFacts; files: PublicationFile[] };
  expected: PublicationDecision;
}[] = [
  {
    name: 'publishes when every file matches the token',
    facts: { token, target, files },
    expected: { kind: 'publish' },
  },
  {
    name: 'refuses when the body changed after the dry run and names it',
    facts: {
      token,
      target,
      files: [title, { ...body, bytes: Buffer.from('Changed.\n') }],
    },
    expected: refusal(
      'body.md changed since the dry run. Nothing was published. Run dryRun again.',
    ),
  },
  {
    name: 'refuses when the title changed after the dry run and names it',
    facts: {
      token,
      target,
      files: [{ ...title, bytes: Buffer.from('Other title\n') }, body],
    },
    expected: refusal(
      'title.md changed since the dry run. Nothing was published. Run dryRun again.',
    ),
  },
  {
    name: 'refuses a token for a different set of files',
    facts: { token, target, files: [body] },
    expected: refusal(
      'The token covers a different set of files. Nothing was published. Run dryRun again.',
    ),
  },
  {
    name: 'refuses a token for another pull request',
    facts: { token, target: { ...target, pr: 8 }, files },
    expected: targetRefusal,
  },
  {
    name: 'refuses a token for another repository',
    facts: { token, target: { ...target, repository: 'github.com/sQVe/other' }, files },
    expected: targetRefusal,
  },
  {
    name: 'refuses a token for another kind',
    facts: { token, target: { ...target, kind: 'comment' }, files },
    expected: targetRefusal,
  },
  {
    name: 'refuses a token for another run directory',
    facts: { token, target: { ...target, directory: '/repo/.tau/pr/run-2' }, files },
    expected: targetRefusal,
  },
  {
    name: 'refuses a token for another base',
    facts: { token: createToken, target: { ...createTarget, base: 'develop' }, files },
    expected: targetRefusal,
  },
  {
    name: 'refuses a token for another head',
    facts: { token: createToken, target: { ...createTarget, head: 'other' }, files },
    expected: targetRefusal,
  },
  {
    name: 'refuses a token for another draft status',
    facts: { token: createToken, target: { ...createTarget, draft: true }, files },
    expected: targetRefusal,
  },
  {
    name: 'refuses a token without the version',
    facts: { token: token.slice('v2:'.length), target, files },
    expected: refusal('The token is not from dryRun. Nothing was published. Run dryRun again.'),
  },
  {
    name: 'refuses text that is not a token',
    facts: { token: 'not-a-token', target, files },
    expected: refusal('The token is not from dryRun. Nothing was published. Run dryRun again.'),
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, { facts, expected }) => {
  expect(decidePublication(facts)).toStrictEqual(expected);
});

it('returns the same token for the same bytes and another token for changed bytes', () => {
  expect(publicationToken(target, files)).toBe(token);

  expect(publicationToken(target, [title, { ...body, bytes: Buffer.from('Changed.\n') }])).not.toBe(
    token,
  );
});

it('returns another token for another target', () => {
  expect(publicationToken({ ...target, pr: 8 }, files)).not.toBe(token);
  expect(publicationToken(createTarget, files)).not.toBe(token);
});

const generatedBytes = array(integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 24 }).map(
  (bytes) => Uint8Array.from(bytes),
);

const namedFiles = (bytesList: readonly Uint8Array[]): PublicationFile[] =>
  bytesList.map((bytes, index) => ({ file: `file-${index}.md`, bytes }));

const nextByte = (bytes: Uint8Array): Uint8Array => {
  const changed = Uint8Array.from(bytes);

  changed[0] = ((changed[0] ?? 0) + 1) % 256;

  return changed;
};

it('publishes its own files and refuses any changed byte or file set', () => {
  const seed = resolvePropertySeed();

  assert(
    property(array(generatedBytes, { minLength: 1, maxLength: 4 }), (bytesList) => {
      const planned = namedFiles(bytesList);
      const plannedToken = publicationToken(target, planned);
      const decision = decidePublication({ token: plannedToken, target, files: planned });

      expect(decision).toStrictEqual({ kind: 'publish' });

      for (const index of planned.keys()) {
        const changed = planned.map((file, fileIndex) =>
          fileIndex === index ? { ...file, bytes: nextByte(file.bytes) } : file,
        );

        const changedDecision = decidePublication({
          token: plannedToken,
          target,
          files: changed,
        });

        expect(changedDecision.kind).toBe('refuse');
      }

      const dropped = planned.slice(1);
      const added = [...planned, { file: 'added.md', bytes: Uint8Array.from([0]) }];

      for (const other of [dropped, added]) {
        const setDecision = decidePublication({
          token: plannedToken,
          target,
          files: other,
        });

        expect(setDecision.kind).toBe('refuse');
      }
    }),
    { seed, numRuns: 100 },
  );
});
