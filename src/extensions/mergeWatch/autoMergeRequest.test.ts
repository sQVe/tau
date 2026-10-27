import { expect, it } from 'vitest';

import { parseAutoMergeRequests } from './autoMergeRequest.js';
import type { AutoMergeRequest } from './autoMergeRequest.js';

const currentBranch: AutoMergeRequest = { selector: undefined, repository: undefined };

const table: { name: string; command: string; requests: AutoMergeRequest[] }[] = [
  {
    name: 'reads auto-merge on the current branch',
    command: 'gh pr merge --auto --squash',
    requests: [currentBranch],
  },
  {
    name: 'reads the pull request argument',
    command: 'gh pr merge 42 --squash --auto',
    requests: [{ selector: '42', repository: undefined }],
  },
  {
    name: 'reads the repository flag',
    command: 'gh pr merge --auto -R owner/repo 42',
    requests: [{ selector: '42', repository: 'owner/repo' }],
  },
  {
    name: 'reads the repository flag with an equals sign',
    command: 'gh pr merge --repo=owner/repo --auto https://github.com/owner/repo/pull/42',
    requests: [{ selector: 'https://github.com/owner/repo/pull/42', repository: 'owner/repo' }],
  },
  {
    name: 'skips the values of flags that take one',
    command: 'gh pr merge --auto --subject "Add the watch" -b body --match-head-commit abc 42',
    requests: [{ selector: '42', repository: undefined }],
  },
  {
    name: 'reads a quoted pull request argument',
    command: "gh pr merge --auto 'feature-branch'",
    requests: [{ selector: 'feature-branch', repository: undefined }],
  },
  {
    name: 'reads a merge chained after another command',
    command: 'git push && GH_PROMPT_DISABLED=1 gh pr merge --auto --squash; echo done',
    requests: [currentBranch],
  },
  {
    name: 'ignores a merge without auto',
    command: 'gh pr merge 42 --squash',
    requests: [],
  },
  {
    name: 'ignores a merge that disables auto-merge',
    command: 'gh pr merge 42 --disable-auto',
    requests: [],
  },
  {
    name: 'ignores other gh commands',
    command: 'gh pr view --auto; gh pr create --fill',
    requests: [],
  },
  {
    name: 'keeps a quoted separator inside its word',
    command: "gh pr merge 12 --auto --body 'a; b' && echo done",
    requests: [{ selector: '12', repository: undefined }],
  },
  {
    name: 'keeps a quoted separator inside a flag value with an equals sign',
    command: 'gh pr merge --auto --subject="Fix foo; improve bar | baz && qux"',
    requests: [currentBranch],
  },
  {
    name: 'reads a merge after a command wrapper',
    command: 'command gh pr merge --auto 5',
    requests: [{ selector: '5', repository: undefined }],
  },
  {
    name: 'ignores a merge printed by another command',
    command: 'echo gh pr merge --auto',
    requests: [],
  },
  {
    name: 'ignores a merge passed to another command after an assignment',
    command: 'GH_HOST=github.com printf %s gh pr merge --auto',
    requests: [],
  },
  {
    name: 'ignores a merge inside a heredoc body',
    command: 'cat <<EOF > notes.md\ngh pr merge --auto\nEOF',
    requests: [],
  },
  {
    name: 'ignores a merge on a later line of a heredoc body',
    command: 'cat <<EOF > notes.md\n# Notes\ngh pr merge --auto\nEOF',
    requests: [],
  },
  {
    name: 'ignores a merge inside a heredoc body with a dash and tabs',
    command: 'cat <<-EOF\n\tgh pr merge --auto\n\tEOF',
    requests: [],
  },
  {
    name: 'ignores a merge inside heredoc bodies with quoted delimiters',
    command: 'cat <<\'EOF\'\ngh pr merge --auto 1\nEOF\ncat << "END"\ngh pr merge --auto 2\nEND',
    requests: [],
  },
  {
    name: 'reads a merge after a heredoc ends',
    command: 'cat <<EOF > notes.md\ngh pr merge --auto 1\nEOF\ngh pr merge --auto 2',
    requests: [{ selector: '2', repository: undefined }],
  },
  {
    name: 'reads a merge after heredoc text inside quotes',
    command:
      'echo \'<<EOF\' && gh pr merge --auto --squash\necho "cat <<EOF"\ngh pr merge --auto 4',
    requests: [currentBranch, { selector: '4', repository: undefined }],
  },
  {
    name: 'reads a merge after heredoc text inside a comment',
    command: 'git push # then cat <<EOF\ngh pr merge --auto 5',
    requests: [{ selector: '5', repository: undefined }],
  },
  {
    name: 'ignores a merge inside a heredoc whose quoted delimiter holds spaces',
    command:
      'cat <<\'END OF NOTES\'\ngh pr merge --auto 1\nEND OF NOTES\ncat <<- "END DOC"\n\tgh pr merge --auto 2\n\tEND DOC\ngh pr merge --auto 6',
    requests: [{ selector: '6', repository: undefined }],
  },
  {
    name: 'reads a merge after a here-string',
    command: 'cat <<<EOF\ngh pr merge --auto 3',
    requests: [{ selector: '3', repository: undefined }],
  },
  {
    name: 'ignores auto in a later command',
    command: 'gh pr merge 42 --squash && echo --auto',
    requests: [],
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, { command, requests }) => {
  expect(parseAutoMergeRequests(command)).toEqual(requests);
});
