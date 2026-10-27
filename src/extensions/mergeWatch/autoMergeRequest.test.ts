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
    name: 'ignores auto in a later command',
    command: 'gh pr merge 42 --squash && echo --auto',
    requests: [],
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, { command, requests }) => {
  expect(parseAutoMergeRequests(command)).toEqual(requests);
});
