import type { Node, Point } from 'web-tree-sitter';

import type { ShellAst } from '../../shell/types.js';

export interface GitCommitHit {
  command: string;
  startIndex: number;
  endIndex: number;
  startPosition: Point;
  endPosition: Point;
  amend: boolean;
}

const gitOptionsWithValue = new Set(['-C', '-c']);

const findGitSubcommand = (args: Node[]): string | undefined => {
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (gitOptionsWithValue.has(arg.text)) {
      skipNext = true;
      continue;
    }

    if (arg.text.startsWith('-')) {
      continue;
    }

    return arg.text;
  }

  return undefined;
};

const isGitCommitCommand = (node: Node) => {
  const [commandName, ...args] = node.namedChildren;

  if (commandName?.type !== 'command_name') {
    return false;
  }

  if (commandName.text === 'git-commit') {
    return true;
  }

  if (commandName.text !== 'git') {
    return false;
  }

  return findGitSubcommand(args) === 'commit';
};

const hasAmendFlag = (node: Node) => node.namedChildren.some((child) => child.text === '--amend');

const toGitCommitHit = (node: Node): GitCommitHit => ({
  command: node.text,
  startIndex: node.startIndex,
  endIndex: node.endIndex,
  startPosition: node.startPosition,
  endPosition: node.endPosition,
  amend: hasAmendFlag(node),
});

const collectGitCommits = (node: Node, hits: GitCommitHit[]) => {
  if (node.type === 'command' && isGitCommitCommand(node)) {
    hits.push(toGitCommitHit(node));
  }

  for (const child of node.namedChildren) {
    collectGitCommits(child, hits);
  }
};

export const findGitCommits = (ast: ShellAst): GitCommitHit[] => {
  const hits: GitCommitHit[] = [];
  collectGitCommits(ast.rootNode, hits);
  return hits;
};
