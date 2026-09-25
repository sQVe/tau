import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors/index.js';
import { executeGroup } from './groupExecution.js';
import type { GroupOutcome } from './groupExecution.js';
import type { CommitSuccess } from './types.js';
import {
  commitToolParameters,
  normalizeBody,
  normalizeRepositoryPath,
  validatePaths,
  validateSubject,
} from './validation.js';
import type { CommitInput } from './validation.js';

const commitToolGuidelines = [
  'When asked to commit, call commit with exact, ordered groups without asking for confirmation. It stages and commits each group with installed Git hooks.',
  'The commit tool stages whole requested files on the real index. Assign each path to one group. Working edits remain visible to hooks. Installed hooks may add paths; commit reports actual committed files relative to the repository root.',
  "Never absorb unrelated edits, another group's paths, or rejected sensitive paths to clear a commit error. Never overwrite concurrent staging or HEAD.",
  "The commit tool runs the repository's installed hooks. Never bypass hooks through --no-verify, core.hooksPath, environment variables, or config changes to evade a failure.",
  'On hook failure, commit unstages requested files and returns raw output unless HEAD changed or unstaging failed. Read cleanup diagnostics before changing the index. Successful hook rewrites and added paths stay committed and are reported. If a hook consumed a later group with no new staged changes, the batch stops. If reporting fails after commit success, inspect Git history before retrying.',
  'The commit tool rejects NUL in messages. Body CRLF and CR become LF; other whitespace is preserved. Nonempty bodies end in LF. Tau supplies the normalized message through git commit --cleanup=verbatim -F and reports the actual stored message.',
  'Use a conventional commit subject.',
  'Do not commit sensitive files such as .env or SSH keys.',
];

interface CommitToolRuntime {
  pi: Pick<ExtensionAPI, 'exec'>;
  context: ExtensionContext;
  signal: AbortSignal | undefined;
}

interface CommitToolResult {
  content: CommitSuccess['content'];
  details: { groups: CommitSuccess['details'][] };
}

const cleanupTemporary = async (directory: string): Promise<string | null> => {
  try {
    await rm(directory, { recursive: true, force: true });

    return null;
  } catch (error) {
    return `Temporary cleanup failed at ${directory}: ${String(error)}`;
  }
};

const validateCommitGroups = (parameters: CommitInput): void => {
  const assigned = new Set<string>();

  for (const group of parameters.groups) {
    validateSubject(group.subject);
    normalizeBody(group.body ?? null);
    validatePaths(group.files);

    for (const file of new Set(group.files.map(normalizeRepositoryPath))) {
      if (assigned.has(file)) {
        throw new Error(
          `Path assigned to multiple groups: ${JSON.stringify(file)}. Assign it to one group and retry.`,
        );
      }

      assigned.add(file);
    }
  }
};

const prefixGroupContent = (
  items: CommitSuccess['content'],
  groupLabel: string,
  groupCount: number,
): CommitSuccess['content'] =>
  // oxlint-disable-next-line oxc/no-map-spread -- Prefix copies without mutating the group's original result.
  items.map((item) => ({
    ...item,
    text: groupCount === 1 ? item.text : `Group ${groupLabel}: ${item.text}`,
  }));

const runGroup = async (
  runtime: CommitToolRuntime,
  group: CommitInput['groups'][number],
  committedGroups: CommitSuccess['details'][],
  groupCount: number,
): Promise<CommitSuccess> => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tau-commit-message-'));
  let outcome: GroupOutcome;

  try {
    outcome = await executeGroup({
      parameters: group,
      temporaryDirectory,
      pi: runtime.pi,
      context: runtime.context,
      signal: runtime.signal,
      committedFiles: new Set(committedGroups.flatMap((committedGroup) => committedGroup.files)),
    });
  } catch (error) {
    const cleanupFailure = await cleanupTemporary(temporaryDirectory);

    if (cleanupFailure !== null) {
      throw new Error(`${errorMessage(error)}\n${cleanupFailure}`, { cause: error });
    }

    throw error;
  }

  const cleanupFailure = await cleanupTemporary(temporaryDirectory);
  const { kind, result } = outcome;

  if (cleanupFailure !== null) {
    result.content.push({ type: 'text', text: cleanupFailure });
  }

  if (kind === 'cancelled' && groupCount > 1) {
    throw new Error(
      cleanupFailure === null ? 'Commit cancelled' : `Commit cancelled\n${cleanupFailure}`,
    );
  }

  return result;
};

const executeCommitTool = async (
  runtime: CommitToolRuntime,
  parameters: CommitInput,
): Promise<CommitToolResult> => {
  validateCommitGroups(parameters);

  const groups: CommitSuccess['details'][] = [];
  const content: CommitSuccess['content'] = [];

  const finish = (items: CommitSuccess['content']): CommitToolResult => ({
    content: items,
    details: { groups },
  });

  if (runtime.signal?.aborted === true) {
    return finish([{ type: 'text', text: 'Commit cancelled' }]);
  }

  /* oxlint-disable eslint/no-await-in-loop -- Each group must finish before the next stages its files. */
  for (const [index, group] of parameters.groups.entries()) {
    const groupLabel = `${index + 1}/${parameters.groups.length}`;

    try {
      const result = await runGroup(runtime, group, groups, parameters.groups.length);

      groups.push(result.details);
      content.push(...prefixGroupContent(result.content, groupLabel, parameters.groups.length));
    } catch (error) {
      if (parameters.groups.length === 1) {
        throw error;
      }

      const committed = content.map((item) => item.text);

      throw new Error(
        `Group ${groupLabel}: ${errorMessage(error)}\nAlready committed:\n${committed.join('\n') || 'None.'}`,
        { cause: error },
      );
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */

  return finish(content);
};

export const createCommitTool = (
  pi: Pick<ExtensionAPI, 'exec'>,
): ToolDefinition<typeof commitToolParameters, { groups: CommitSuccess['details'][] }> =>
  defineTool({
    name: 'commit',
    label: 'Commit',
    description:
      'Stage and commit each group sequentially with Git hooks. Hook failures return errors.',
    promptSnippet: 'Create git commits for an ordered groups array in one call.',
    promptGuidelines: commitToolGuidelines,
    parameters: commitToolParameters,
    // eslint-disable-next-line eslint/max-params -- Pi calls execute with five positional arguments.
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      return executeCommitTool({ pi, context, signal }, parameters);
    },
  });
