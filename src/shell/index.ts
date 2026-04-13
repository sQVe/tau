import { createRequire } from 'node:module';

import { Language, Parser } from 'web-tree-sitter';

import type { ShellAst } from './types.js';

const require = createRequire(import.meta.url);
const webTreeSitterWasmPath = require.resolve('web-tree-sitter/web-tree-sitter.wasm');
const bashGrammarWasmPath = require.resolve('../../vendor/tree-sitter-bash.wasm');

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

  // Defensive: tree-sitter returns null on internal parser failure (not on syntax errors).
  if (tree === null) {
    throw new Error('Failed to parse bash command');
  }

  return tree;
};
