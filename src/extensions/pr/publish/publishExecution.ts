import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { CommandRuntime } from '../../../command.js';
import { runCommand } from '../../../command.js';
import { label } from '../../../github/github.js';
import { isRecord } from '../../../schema.js';
import type { PublicationKind } from './publishKind.js';
import type { FileArgument } from './publishPlan.js';

interface VerifiedCopy {
  path: string;
  bytes: Uint8Array;
}

export interface VerifiedCommand {
  commandArguments: string[];
  copies: VerifiedCopy[];
}

const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

// Rewrites every file argument to a unique copy below directory, so equal basenames cannot collide.
export const verifiedCopyArguments = (
  commandArguments: readonly string[],
  fileArguments: readonly FileArgument[],
  directory: string,
): VerifiedCommand => {
  if (fileArguments.length === 0) {
    throw new Error('The publication command names no file to read.');
  }

  const rewritten = [...commandArguments];
  const copies: VerifiedCopy[] = [];

  for (const { index, file } of fileArguments) {
    if (commandArguments[index] !== file.path) {
      throw new Error('The publication command reads a file the plan did not verify.');
    }

    const path = join(directory, `${index}-${basename(file.path)}`);

    rewritten[index] = path;
    copies.push({ path, bytes: file.bytes });
  }

  return { commandArguments: rewritten, copies };
};

// gh reads the file when it runs, so the verified bytes go to a private copy that cannot change
// between the token check and the read.
export const runWithVerifiedBytes = async (
  runtime: CommandRuntime,
  commandArguments: readonly string[],
  fileArguments: readonly FileArgument[],
): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-publish-'));

  try {
    await chmod(directory, privateDirectoryMode);

    const verified = verifiedCopyArguments(commandArguments, fileArguments, directory);

    await Promise.all(
      verified.copies.map((copy) => writeFile(copy.path, copy.bytes, { mode: privateFileMode })),
    );

    return await runCommand(runtime, 'gh', verified.commandArguments, label(commandArguments));
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
};

const escapePattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const urlSuffix: Readonly<Record<PublicationKind, string>> = {
  pullRequest: '',
  comment: '#issuecomment-\\d+',
  review: '#pullrequestreview-\\d+',
};

// GitHub names are case-insensitive, and gh prints the canonical case.
const publishedUrlPattern = (kind: PublicationKind, repository: string): RegExp =>
  new RegExp(`^https://${escapePattern(repository)}/pull/\\d+${urlSuffix[kind]}$`, 'iu');

const reviewUrls = (stdout: string): string[] => {
  try {
    const value: unknown = JSON.parse(stdout);
    const url = isRecord(value) ? value.html_url : undefined;

    return typeof url === 'string' ? [url] : [];
  } catch {
    return [];
  }
};

export const publishedUrl = (
  kind: PublicationKind,
  repository: string,
  stdout: string,
): string | null => {
  const pattern = publishedUrlPattern(kind, repository);
  const candidates = kind === 'review' ? reviewUrls(stdout) : stdout.split(/\r?\n/u);

  return candidates.find((candidate) => pattern.test(candidate)) ?? null;
};
