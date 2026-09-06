import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { defineTool } from '@mariozechner/pi-coding-agent';
import type { Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';

import type { CommitView } from './overlay.js';
import { confirmCommitOverlay } from './overlay.js';
import type { CommitFailure, CommitSuccess } from './types.js';

export const conventionalCommitSubjectPattern =
  /^(feat|fix|chore|refactor|docs|test|style|perf|build|ci|revert)(\([a-z0-9-]+\))?!?: [^\r\n]+$/;

export const sensitivePathDenylist = [
  /^\.env$/,
  /^\.env\..+$/,
  /^\.npmrc$/,
  /credentials/i,
  /secret/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)id_rsa($|\.)/,
  /(^|\/)id_ed25519($|\.)/,
  /^\.ssh\//,
] as const;

export const commitToolParameters = Type.Object({
  files: Type.Array(Type.String(), { minItems: 1 }),
  subject: Type.String(),
  body: Type.Optional(Type.String()),
  group: Type.Optional(
    Type.String({
      description:
        'Optional marker rendered after "commit" in the overlay title (e.g. "2/5") so the caller can wait on it.',
    }),
  ),
});

export type CommitInput = Static<typeof commitToolParameters>;

const hookFailurePattern = /hook/i;

const detectHookFailure = (stdout: string, stderr: string) =>
  hookFailurePattern.test(stderr) || hookFailurePattern.test(stdout);

export class CommitFailedError extends Error {
  readonly detail: CommitFailure;

  constructor(stdout: string, stderr: string) {
    super(`git commit failed: ${stderr.trim() || stdout.trim()}`.trim());
    this.name = 'CommitFailedError';
    this.detail = {
      hookFailed: detectHookFailure(stdout, stderr),
      stdout,
      stderr,
    };
  }
}

export const validateSubject = (subject: string) => {
  if (!conventionalCommitSubjectPattern.test(subject)) {
    throw new Error(`Invalid subject: ${subject}`);
  }
};

const normalizeRepoPath = (file: string) => file.replaceAll('\\', '/').replace(/^\.\//, '');

export const validatePaths = (files: string[]) => {
  for (const rawFile of files) {
    const file = normalizeRepoPath(rawFile);

    if (
      file.length === 0 ||
      rawFile.startsWith(':') ||
      rawFile.startsWith('/') ||
      file.startsWith('../') ||
      file.includes('/../')
    ) {
      throw new Error(`Invalid path: ${rawFile}`);
    }

    if (sensitivePathDenylist.some((pattern) => pattern.test(file))) {
      throw new Error(`Invalid path: ${rawFile}`);
    }
  }
};

const buildCommitMessage = (subject: string, body?: string) => {
  if (body !== undefined) {
    return `${subject}\n\n${body}`;
  }

  return subject;
};

const listStagedPaths = async (pi: Pick<ExtensionAPI, 'exec'>, cwd: string) => {
  const result = await pi.exec(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMRD', '-z'],
    {
      cwd,
    },
  );

  if (result.code !== 0) {
    throw new Error(
      `git diff --cached --name-only failed with exit code ${result.code}: ${result.stderr || result.stdout}`.trim(),
    );
  }

  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((file) => normalizeRepoPath(file));
};

const stageFiles = async (pi: Pick<ExtensionAPI, 'exec'>, cwd: string, files: string[]) => {
  const result = await pi.exec('git', ['add', '--', ...files], { cwd });
  if (result.code !== 0) {
    throw new Error(
      `git add failed with exit code ${result.code}: ${result.stderr || result.stdout}`.trim(),
    );
  }
};

const unstageFiles = async (pi: Pick<ExtensionAPI, 'exec'>, cwd: string, files: string[]) => {
  const result = await pi.exec('git', ['reset', '--', ...files], { cwd });
  if (result.code !== 0) {
    throw new Error(
      `git reset failed with exit code ${result.code}: ${result.stderr || result.stdout}`.trim(),
    );
  }
};

const stagedNumstat = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  cwd: string,
  files: string[],
): Promise<CommitView['files']> => {
  const result = await pi.exec(
    'git',
    ['diff', '--cached', '--numstat', '--no-renames', '-z', '--', ...files],
    { cwd },
  );
  if (result.code !== 0) {
    throw new Error(
      `git diff --cached --numstat failed with exit code ${result.code}: ${result.stderr || result.stdout}`.trim(),
    );
  }
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const [added = '0', removed = '0', ...path] = row.split('\t');
      return { path: path.join('\t'), added, removed };
    });
};

export const createCommitTool = (pi: Pick<ExtensionAPI, 'exec'>) =>
  defineTool({
    name: 'commit',
    label: 'Commit',
    description: 'Stage specific files and create a git commit with a validated subject.',
    promptSnippet: 'Create a git commit for specific files using a conventional commit subject.',
    promptGuidelines: [
      'When asked to commit, call this tool without asking for confirmation in chat first. Its overlay is the only approval step; the user approves, edits, skips, or aborts there, even for changes that look temporary or wrong.',
      'Only commit the files explicitly provided.',
      'Use a conventional commit subject.',
      'Do not commit sensitive files such as .env or SSH keys.',
    ],
    parameters: commitToolParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<CommitSuccess> {
      validateSubject(params.subject);
      validatePaths(params.files);

      if (!ctx.hasUI) {
        throw new Error('Cannot commit without user confirmation (non-interactive mode)');
      }

      let subject = params.subject;
      let body = params.body ?? null;
      const cancelled = (): CommitSuccess => ({
        content: [{ type: 'text', text: 'Commit cancelled' }],
        details: { sha: '', files: params.files, subject, body },
      });
      if (signal?.aborted) {
        return cancelled();
      }

      const requestedFiles = new Set(params.files.map((file) => normalizeRepoPath(file)));
      const stagedPaths = await listStagedPaths(pi, ctx.cwd);
      const unrelatedStagedPaths = stagedPaths.filter((file) => !requestedFiles.has(file));

      if (unrelatedStagedPaths.length > 0) {
        throw new Error(
          `Cannot commit only the requested files while other paths are already staged: ${unrelatedStagedPaths.join(', ')}`,
        );
      }

      await stageFiles(pi, ctx.cwd, params.files);
      let approved = false;
      try {
        const files = await stagedNumstat(pi, ctx.cwd, params.files);
        let notice = '';
        while (true) {
          if (signal?.aborted) {
            return cancelled();
          }
          const choice = await confirmCommitOverlay(
            ctx,
            {
              subject,
              body,
              files,
              ...(params.group !== undefined ? { group: params.group } : {}),
              notice,
            },
            signal,
          );
          notice = '';
          if (signal?.aborted) {
            return cancelled();
          }
          if (choice === 'approve') {
            approved = true;
            break;
          }
          if (choice === 'skip') {
            return {
              content: [{ type: 'text', text: 'Commit skipped by user' }],
              details: { sha: '', files: params.files, subject, body, skipped: true },
            };
          }
          if (choice === 'abort') {
            throw new Error('Commit declined by user');
          }
          if (choice === 'subject') {
            const edited = await ctx.ui.editor('Edit subject', subject);
            if (edited !== undefined) {
              try {
                validateSubject(edited);
                subject = edited;
              } catch (error) {
                notice = error instanceof Error ? error.message : String(error);
              }
            }
          } else {
            body = (await ctx.ui.editor('Edit body', body ?? '')) ?? body;
          }
        }
      } finally {
        if (!approved) {
          await unstageFiles(pi, ctx.cwd, params.files);
        }
      }

      const commitResult = await pi.exec(
        'git',
        ['commit', '-m', buildCommitMessage(subject, body ?? undefined)],
        {
          cwd: ctx.cwd,
        },
      );
      if (commitResult.code !== 0) {
        throw new CommitFailedError(commitResult.stdout, commitResult.stderr);
      }

      const revParseResult = await pi.exec('git', ['rev-parse', 'HEAD'], {
        cwd: ctx.cwd,
      });
      if (revParseResult.code !== 0) {
        throw new Error(
          `git rev-parse HEAD failed with exit code ${revParseResult.code}: ${revParseResult.stderr || revParseResult.stdout}`.trim(),
        );
      }

      const sha = revParseResult.stdout.trim();

      return {
        content: [{ type: 'text', text: `${sha} ${subject}` }],
        details: {
          sha,
          files: params.files,
          subject,
          body,
        },
      };
    },
  });
