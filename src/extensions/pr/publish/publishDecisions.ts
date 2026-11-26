import { createHash } from 'node:crypto';

export interface PublicationFile {
  file: string;
  bytes: Uint8Array;
}

// The facts that choose where a publication goes. Text that comes from a file, such as the title,
// stays out so a changed file is named as the changed file.
export interface PublicationTargetFacts {
  kind: string;
  repository: string;
  directory: string;
  pr?: number;
  base?: string;
  head?: string;
  draft?: boolean;
}

export interface PublicationFacts {
  token: string;
  target: PublicationTargetFacts;
  files: readonly PublicationFile[];
}

export type PublicationDecision = { kind: 'publish' } | { kind: 'refuse'; reason: string };

const tokenVersion = 'v2';
const separator = ':';
const unversionedToken = 'The token is not from dryRun. Nothing was published. Run dryRun again.';

const differentTarget =
  'The token covers a different publication target. Nothing was published. Run dryRun again.';

const digestOf = (content: Uint8Array | string): string =>
  createHash('sha256').update(content).digest('hex');

const optionalPart = (value: number | string | boolean | undefined): string =>
  value === undefined ? '' : String(value);

const targetParts = (target: PublicationTargetFacts): string[] => [
  target.kind,
  target.repository,
  target.directory,
  optionalPart(target.pr),
  optionalPart(target.base),
  optionalPart(target.head),
  optionalPart(target.draft),
];

// Hashing each part alone keeps the separator out of the joined text, so two targets cannot share
// a digest by moving the separator between parts.
const targetDigest = (target: PublicationTargetFacts): string => {
  const digests = targetParts(target).map((part) => digestOf(part));
  const joined = digests.join(separator);

  return digestOf(joined);
};

export const publicationToken = (
  target: PublicationTargetFacts,
  files: readonly PublicationFile[],
): string =>
  [tokenVersion, targetDigest(target), ...files.map((file) => digestOf(file.bytes))].join(
    separator,
  );

const refusal = (reason: string): PublicationDecision => ({ kind: 'refuse', reason });

export const decidePublication = (facts: PublicationFacts): PublicationDecision => {
  const [version, target, ...digests] = facts.token.split(separator);

  if (version !== tokenVersion) {
    return refusal(unversionedToken);
  }

  if (target !== targetDigest(facts.target)) {
    return refusal(differentTarget);
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
