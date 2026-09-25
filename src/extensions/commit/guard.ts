import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import type { ToolCallEvent, ToolCallEventResult } from '@earendil-works/pi-coding-agent';

import { parseShellCommands } from './shellCommands.js';
import type { ShellCommand } from './shellCommands.js';

export const commitGuardReason = 'Blocked git commit via bash. Use the `commit` tool instead.';

// Used only when the command does not parse. It matches `commit` anywhere after `git` in a
// statement, so it blocks mentions in quoted text too.
const gitCommitPattern = /\bgit\b[^;|&\n]*(?<![\w/-])commit(?![\w/])|\bgit-commit\b/i;

// Commands that may run a string or standard input as shell code. When one appears anywhere in the
// source, every word and heredoc body in that source is parsed as a script too, because piped data
// such as `echo 'git commit' | sh` becomes code.
const shellRunnerNames = new Set([
  'ash',
  'bash',
  'dash',
  'eval',
  'ksh',
  'mksh',
  'sh',
  'ssh',
  'su',
  'zsh',
]);

// Words with these characters may parse into more than themselves when run as shell code.
const shellSyntaxPattern = /[\s;&|()<>`'"\\$]/;

// Normalize common shell spellings such as `g\it c''ommit` before matching.
const unescapeShellWord = (command: string) =>
  command.replaceAll('\\\n', '').replaceAll(/\\(.)/gs, '$1').replaceAll(/''|""/g, '');

const commandName = (word: string) => word.slice(word.lastIndexOf('/') + 1).toLowerCase();

// Matches `commit` and plumbing such as `commit-tree`, and also `commit-graph`: blocking wins.
// A substitution or `key=value` word that mentions `commit` may produce the subcommand or define an
// alias for it, as in `git -c alias.x=commit x`, so it matches too. That also blocks
// `git log --grep=commit`.
const isCommitWord = (word: string) => {
  const lowerWord = word.toLowerCase();
  const mayProduceCommit = ['$(', '`', '='].some((marker) => lowerWord.includes(marker));
  const producesCommit = mayProduceCommit && lowerWord.includes('commit');

  return /^commit(?:-|$)/.test(lowerWord) || producesCommit;
};

// Any word named `git` counts, so wrappers such as `env`, `sudo`, and `xargs` need no list, and
// options between `git` and `commit` are skipped. Variable indirection (`c=commit; git $c`) still
// bypasses this.
const runsGitCommit = ({ words }: ShellCommand) => {
  const names = words.map(commandName);
  const gitIndex = names.indexOf('git');
  const laterWords = gitIndex === -1 ? [] : words.slice(gitIndex + 1);

  return names.includes('git-commit') || laterWords.some(isCommitWord);
};

const runsShell = ({ words }: ShellCommand) =>
  words.some((word) => shellRunnerNames.has(commandName(word)));

// Git runs some quoted arguments as shell code, as in `git rebase -x` and `git submodule foreach`.
const runsGit = ({ words }: ShellCommand) => words.some((word) => commandName(word) === 'git');

const scriptsOf = (commands: ShellCommand[]) =>
  commands.flatMap(({ words, heredocs }) => [
    ...words.filter((word) => shellSyntaxPattern.test(word)),
    ...heredocs,
  ]);

// Substitutions keep their source text, so `bash $(bash)` would reparse itself without a limit.
const maximumScriptDepth = 8;

const createsCommit = (source: string, depth = 0): boolean => {
  if (depth > maximumScriptDepth) {
    return true;
  }

  const commands = parseShellCommands(source);

  if (commands === undefined) {
    return gitCommitPattern.test(unescapeShellWord(source));
  }

  if (commands.some(runsGitCommit)) {
    return true;
  }

  const scriptCommands = commands.some(runsShell) ? commands : commands.filter(runsGit);
  const scripts = scriptsOf(scriptCommands);

  return scripts.some((script) => createsCommit(script, depth + 1));
};

export const guardToolCall = (event: ToolCallEvent): ToolCallEventResult | undefined => {
  if (!isToolCallEventType('bash', event)) {
    return undefined;
  }

  if (createsCommit(event.input.command)) {
    return { block: true, reason: commitGuardReason };
  }

  return undefined;
};
