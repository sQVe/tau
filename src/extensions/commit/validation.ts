import { posix } from 'node:path';

import type { Static } from 'typebox';
import { Type } from 'typebox';

const conventionalCommitSubjectPattern =
  /^(feat|fix|chore|refactor|docs|test|style|perf|build|ci|revert)(\([a-z0-9-]+\))?!?: [^\r\n]+$/;

const sensitivePathDenylist = [
  /(^|\/)\.env$/i,
  /(^|\/)\.env\..+$/i,
  /(^|\/)\.npmrc$/i,
  /credentials/i,
  /secret/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)id_rsa($|\.)/i,
  /(^|\/)id_ed25519($|\.)/i,
  /(^|\/)\.ssh($|\/)/i,
] as const;

export const isSensitivePath = (file: string) =>
  sensitivePathDenylist.some((pattern) => pattern.test(file.replaceAll('\\', '/')));

export const commitToolParameters = Type.Object({
  groups: Type.Array(
    Type.Object({
      files: Type.Array(Type.String(), { minItems: 1 }),
      subject: Type.String(),
      body: Type.Optional(Type.String()),
    }),
    { minItems: 1 },
  ),
});

export type CommitInput = Static<typeof commitToolParameters>;

// Pi forwards only error.message, so include hook diagnostics from both streams.
export const commitFailedError = (stdout: string, stderr: string) =>
  new Error(`git commit failed:\n${stdout}${stderr}`);

export const validateSubject = (subject: string) => {
  if (subject.includes('\0')) {
    throw new Error('Invalid subject: NUL is not allowed.');
  }

  if (!conventionalCommitSubjectPattern.test(subject)) {
    throw new Error(`Invalid subject: ${subject}`);
  }
};

export const normalizeRepositoryPath = (file: string) =>
  posix
    .normalize(process.platform === 'win32' ? file.replaceAll('\\', '/') : file)
    .replace(/\/+$/, '');

const isInvalidPath = (rawFile: string, file: string): boolean => {
  const invalidName = rawFile.includes('\0') || file === '' || file === '.';

  return invalidName || rawFile.startsWith(':');
};

const isOutsideWorktree = (file: string): boolean =>
  posix.isAbsolute(file) || file === '..' || file.startsWith('../');

export const validatePaths = (files: string[]) => {
  for (const rawFile of files) {
    // Validate the backslash reading on every platform so a Windows-style traversal or sensitive
    // name is rejected everywhere, while staging keeps the literal name on POSIX.
    const file = posix.normalize(rawFile.replaceAll('\\', '/')).replace(/\/+$/, '');

    if (isInvalidPath(rawFile, file)) {
      throw new Error(`Invalid path: ${rawFile}`);
    }

    if (isOutsideWorktree(file)) {
      throw new Error(
        `Invalid path: ${rawFile}. Use a path inside this session's cwd, relative to it; commit other worktrees from a session there.`,
      );
    }

    if (isSensitivePath(file)) {
      throw new Error(`Invalid path: ${rawFile}`);
    }
  }
};

export const normalizeBody = (body: string | null) => {
  if (body == null || body === '') {
    return body;
  }

  if (body.includes('\0')) {
    throw new Error('Invalid body: NUL is not allowed.');
  }

  const normalized = body.replaceAll(/\r\n?/g, '\n');

  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
};

export const buildCommitMessage = (subject: string, body: string | null) =>
  body == null || body === '' ? `${subject}\n` : `${subject}\n\n${body}`;
