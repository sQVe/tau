import { createHash } from 'node:crypto';

export interface PublicationFile {
  file: string;
  bytes: Uint8Array;
}

export interface PublicationFacts {
  token: string;
  files: readonly PublicationFile[];
}

export type PublicationDecision = { kind: 'publish' } | { kind: 'refuse'; reason: string };

const tokenVersion = 'v1';
const separator = ':';
const unversionedToken = 'The token is not from dryRun. Nothing was published. Run dryRun again.';

const digestOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const publicationToken = (files: readonly PublicationFile[]): string =>
  [tokenVersion, ...files.map((file) => digestOf(file.bytes))].join(separator);

const refusal = (reason: string): PublicationDecision => ({ kind: 'refuse', reason });

export const decidePublication = (facts: PublicationFacts): PublicationDecision => {
  const [version, ...digests] = facts.token.split(separator);

  if (version !== tokenVersion) {
    return refusal(unversionedToken);
  }

  if (digests.length !== facts.files.length) {
    return refusal(
      'The token covers a different set of files. Nothing was published. Run dryRun again.',
    );
  }

  const changed = facts.files.find((file, index) => digestOf(file.bytes) !== digests[index]);

  if (changed === undefined) {
    return { kind: 'publish' };
  }

  return refusal(
    `${changed.file} changed since the dry run. Nothing was published. Run dryRun again.`,
  );
};
