import { expect, it } from 'vitest';

import { decidePublication, publicationToken } from './publishDecisions.js';
import type { PublicationDecision, PublicationFile } from './publishDecisions.js';

const title: PublicationFile = { file: 'title.md', bytes: Buffer.from('Add a feature\n') };
const body: PublicationFile = { file: 'body.md', bytes: Buffer.from('Adds it.\n') };
const files = [title, body];
const token = publicationToken(files);

const refusal = (reason: string): PublicationDecision => ({ kind: 'refuse', reason });

const table: {
  name: string;
  facts: { token: string; files: PublicationFile[] };
  expected: PublicationDecision;
}[] = [
  {
    name: 'publishes when every file matches the token',
    facts: { token, files },
    expected: { kind: 'publish' },
  },
  {
    name: 'refuses when the body changed after the dry run and names it',
    facts: { token, files: [title, { ...body, bytes: Buffer.from('Changed.\n') }] },
    expected: refusal(
      'body.md changed since the dry run. Nothing was published. Run dryRun again.',
    ),
  },
  {
    name: 'refuses when the title changed after the dry run and names it',
    facts: { token, files: [{ ...title, bytes: Buffer.from('Other title\n') }, body] },
    expected: refusal(
      'title.md changed since the dry run. Nothing was published. Run dryRun again.',
    ),
  },
  {
    name: 'refuses a token for a different set of files',
    facts: { token, files: [body] },
    expected: refusal(
      'The token covers a different set of files. Nothing was published. Run dryRun again.',
    ),
  },
  {
    name: 'refuses a token without the version',
    facts: { token: token.slice('v1:'.length), files },
    expected: refusal('The token is not from dryRun. Nothing was published. Run dryRun again.'),
  },
  {
    name: 'refuses text that is not a token',
    facts: { token: 'not-a-token', files },
    expected: refusal('The token is not from dryRun. Nothing was published. Run dryRun again.'),
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, { facts, expected }) => {
  expect(decidePublication(facts)).toStrictEqual(expected);
});

it('returns the same token for the same bytes and another token for changed bytes', () => {
  expect(publicationToken(files)).toBe(token);
  expect(publicationToken([title, { ...body, bytes: Buffer.from('Changed.\n') }])).not.toBe(token);
});
