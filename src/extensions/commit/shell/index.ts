import { createRequire } from 'node:module';

import { Language, Parser } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';

import type { GitCommitHit, ShellAst } from './types.js';

const require = createRequire(import.meta.url);
const webTreeSitterWasmPath = require.resolve('web-tree-sitter/web-tree-sitter.wasm');
const bashGrammarWasmPath = require.resolve('../../../../vendor/tree-sitter-bash.wasm');

let parserPromise: Promise<Parser> | undefined;

const loadParser = async () => {
  await Parser.init({
    locateFile(scriptName: string) {
      if (scriptName === 'web-tree-sitter.wasm') {
        return webTreeSitterWasmPath;
      }

      return scriptName;
    },
  });

  const language = await Language.load(bashGrammarWasmPath);
  const parser = new Parser();
  parser.setLanguage(language);

  return parser;
};

const getParser = () => {
  parserPromise ??= loadParser();
  return parserPromise;
};

export const parseBash = async (command: string): Promise<ShellAst> => {
  const parser = await getParser();
  const tree = parser.parse(command);

  if (tree === null) {
    throw new Error('Failed to parse bash command');
  }

  return tree;
};

const isGitCommitCommand = (node: Node) => {
  const [commandName, ...args] = node.namedChildren;

  if (commandName?.type !== 'command_name') {
    return false;
  }

  if (commandName.text === 'git-commit') {
    return true;
  }

  return commandName.text === 'git' && args.some((arg) => arg.text === 'commit');
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
