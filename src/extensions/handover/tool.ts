import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { isMissingFile } from '../../errors.js';
import { findCheckoutRoot, readGitOutput } from '../../gitOutput.js';
import { ensureTauDirectory } from '../../tauDirectory.js';

const parameters = Type.Object({ action: Type.Literal('prepare') });

const findBareRoot = async (cwd: string) => {
  const output = await readGitOutput(cwd, ['rev-parse', '--absolute-git-dir']);
  const path = output?.trim();

  if (path === undefined || path === '') {
    throw new Error(`The handover tool could not resolve the bare Git directory from ${cwd}.`);
  }

  const gitDirectory = await realpath(path);
  const parent = dirname(gitDirectory);
  const gitFile = join(parent, '.git');

  try {
    const stats = await stat(gitFile);

    if (!stats.isFile()) {
      return gitDirectory;
    }

    const content = await readFile(gitFile, 'utf8');
    const target = /^gitdir: (.+)\r?\n?$/.exec(content)?.[1];

    if (target !== undefined) {
      const targetDirectory = await realpath(resolve(parent, target.trim()));

      if (targetDirectory === gitDirectory) {
        return parent;
      }
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  return gitDirectory;
};

const prepare = async (cwd: string) => {
  const bare = await readGitOutput(cwd, ['rev-parse', '--is-bare-repository']);

  const root =
    bare?.trim() === 'true' ? await findBareRoot(cwd) : await findCheckoutRoot(cwd, 'handover');

  return { directory: await ensureTauDirectory(root, 'handovers') };
};

export const createHandoverTool = (): ToolDefinition<typeof parameters, { directory: string }> =>
  defineTool({
    name: 'handover',
    label: 'Handover',
    description: `Prepare a directory for a handover message.
- action prepare: creates .tau/handovers in the current checkout or bare repository root and ensures .tau/.gitignore ends with *. Returns {directory}, an absolute path. Reuses an existing directory.
- For a bare repository, uses the parent with a matching .git file, or the Git directory itself. Nested calls resolve to the same root.
- Errors: no Git repository, an unresolved bare Git directory, a symlink in the directory path or at .tau/.gitignore, a hard-linked .tau/.gitignore, a tracked destination or ignore file in a worktree, or an ignore exception after the last * in a bare root. In a worktree, prepare appends * after existing exceptions.`,
    promptSnippet: 'Prepare the local directory for a handover message.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, _parameters, _signal, _onUpdate, context) {
      const details = await prepare(context.cwd);

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
