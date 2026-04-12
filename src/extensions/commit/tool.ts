import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { defineTool } from '@mariozechner/pi-coding-agent';
import type { Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';

import type { CommitFailure, CommitSuccess } from './types.js';

export const conventionalCommitSubjectPattern =
  /^(feat|fix|chore|refactor|docs|test|style|perf|build|ci|revert)(\([a-z0-9-]+\))?!?: .+/;

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
});

export type CommitInput = Static<typeof commitToolParameters>;

const hookFailurePattern = /hook/i;

const detectHookFailure = (stdout: string, stderr: string) =>
  hookFailurePattern.test(stderr) || hookFailurePattern.test(stdout);

export class CommitFailedError extends Error {
  readonly detail: CommitFailure;

  constructor(stdout: string, stderr: string) {
    super('git commit failed');
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

export const validatePaths = (files: string[]) => {
  for (const file of files) {
    if (sensitivePathDenylist.some((pattern) => pattern.test(file))) {
      throw new Error(`Invalid path: ${file}`);
    }
  }
};

const buildCommitMessage = (subject: string, body?: string) => {
  if (body !== undefined) {
    return `${subject}\n\n${body}`;
  }

  return subject;
};

export const createCommitTool = (pi: Pick<ExtensionAPI, 'exec'>) =>
  defineTool({
    name: 'commit',
    label: 'Commit',
    description: 'Stage specific files and create a git commit with a validated subject.',
    promptSnippet: 'Create a git commit for specific files using a conventional commit subject.',
    promptGuidelines: [
      'Only commit the files explicitly provided.',
      'Use a conventional commit subject.',
      'Do not commit sensitive files such as .env or SSH keys.',
    ],
    parameters: commitToolParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<CommitSuccess> {
      validateSubject(params.subject);
      validatePaths(params.files);

      if (!ctx.hasUI) {
        throw new Error('Cannot commit without user confirmation (non-interactive mode)');
      }

      const fileList = params.files.map((file) => `  ${file}`).join('\n');
      const message = params.body != null ? `${fileList}\n\n${params.body}` : fileList;
      const confirmed = await ctx.ui.confirm(params.subject, message);
      if (!confirmed) {
        throw new Error('Commit declined by user');
      }

      const addResult = await pi.exec('git', ['add', '--', ...params.files], {
        cwd: ctx.cwd,
      });
      if (addResult.code !== 0) {
        throw new Error(
          `git add failed with exit code ${addResult.code}: ${addResult.stderr || addResult.stdout}`.trim(),
        );
      }

      const commitResult = await pi.exec(
        'git',
        ['commit', '-m', buildCommitMessage(params.subject, params.body), '--', ...params.files],
        { cwd: ctx.cwd },
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
        content: [{ type: 'text', text: `${sha} ${params.subject}` }],
        details: {
          sha,
          files: params.files,
          subject: params.subject,
        },
      };
    },
  });
