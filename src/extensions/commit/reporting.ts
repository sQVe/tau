import type { GitResult, runGit } from '../../git.js';
import { decodeOutput, listCommitPaths, readGitText } from './gitCommands.js';
import type { CommitSuccess } from './types.js';
import { isSensitivePath } from './validation.js';

interface CommitReporting {
  runner: typeof runGit;
  cwd: string;
  snapshot: {
    readonly tree: string;
    readonly head: string | null;
  };
  expectedMessage: string;
  commitResult: GitResult;
}

const buildHookReport = (
  expectedMessage: string,
  committedPaths: string[],
  changedPathsOutput: string,
  storedMessage: string,
) => {
  const hookChanges = {
    files: changedPathsOutput.split('\0').filter(Boolean),
    message: storedMessage !== expectedMessage,
  };

  const sensitivePaths = committedPaths.filter((file) => isSensitivePath(file));
  const reportLines: string[] = [];

  if (sensitivePaths.length > 0) {
    reportLines.push(`Warning: committed sensitive paths: ${sensitivePaths.join(', ')}`);
  }

  if (hookChanges.files.length > 0) {
    reportLines.push(`Hook changed paths: ${hookChanges.files.join(', ')}`);
  }

  if (hookChanges.message) {
    reportLines.push(`Hook changed the commit message:\n${storedMessage}`);
  }

  const hookReport = reportLines.join('\n');

  return { hookChanges, hookReport };
};

const buildCommitReport = async (
  reporting: CommitReporting,
  commitHash: string,
  commitObject: string,
  messageOffset: number,
): Promise<CommitSuccess> => {
  const committedPaths = await listCommitPaths(reporting.runner, reporting.cwd, commitHash);
  const storedMessage = commitObject.slice(messageOffset + 2);
  const firstNewline = storedMessage.indexOf('\n');
  const storedSubject = firstNewline === -1 ? storedMessage : storedMessage.slice(0, firstNewline);

  const storedBody =
    firstNewline === -1 ? '' : storedMessage.slice(firstNewline + 1).replace(/^\n/, '');

  const changedPathsOutput = await readGitText(reporting.runner, reporting.cwd, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--no-relative',
    '--name-only',
    '-z',
    reporting.snapshot.tree,
    `${commitHash}^{tree}`,
    '--',
  ]);

  const { hookChanges, hookReport } = buildHookReport(
    reporting.expectedMessage,
    committedPaths,
    changedPathsOutput,
    storedMessage,
  );

  const reportLines = [`${commitHash} ${storedSubject}`, 'Git hooks: run.'];

  if (hookReport) {
    reportLines.push(hookReport);
  }

  return {
    content: [
      {
        type: 'text',
        text: reportLines.join('\n'),
      },
    ],
    details: {
      sha: commitHash,
      files: committedPaths,
      subject: storedSubject,
      body: storedBody || null,
      message: storedMessage,
      hooks: 'run',
      hookChanges,
    },
  };
};

export const reportCommit = async (reporting: CommitReporting): Promise<CommitSuccess> => {
  let commitHash = '';

  try {
    const commitHashOutput = await readGitText(reporting.runner, reporting.cwd, [
      'rev-parse',
      'HEAD',
    ]);

    const capturedHead = commitHashOutput.trim();

    const commitObject = await readGitText(reporting.runner, reporting.cwd, [
      'cat-file',
      '-p',
      capturedHead,
    ]);

    const messageOffset = commitObject.indexOf('\n\n');
    const firstParent = commitObject.slice(0, messageOffset).match(/^parent (.+)$/m)?.[1] ?? null;

    if (firstParent !== reporting.snapshot.head) {
      throw new Error(
        "HEAD changed before commit reporting. The captured HEAD could not be verified as this group's commit. HEAD and staging were left untouched.",
      );
    }

    commitHash = capturedHead;

    return await buildCommitReport(reporting, commitHash, commitObject, messageOffset);
  } catch (error) {
    const commitSuffix = commitHash ? `: ${commitHash}` : '';

    throw new Error(
      `Git commit succeeded${commitSuffix}. The commit was not undone.\nReporting failed: ${String(error)}\nDo not retry this group. Inspect Git history first.\n${decodeOutput(reporting.commitResult)}${reporting.commitResult.stderr}`,
      { cause: error },
    );
  }
};
