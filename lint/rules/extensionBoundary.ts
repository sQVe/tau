import { posix } from 'node:path';

import type { ESTree, Rule } from '@oxlint/plugins';

// The extension directory a path belongs to; src/extensions/index.ts composes them and has none.
const extensionOf = (path: string): string | undefined => {
  const segments = path.replaceAll('\\', '/').split('/');
  const index = segments.lastIndexOf('extensions');
  const insideExtension = segments[index - 1] === 'src' && index + 2 < segments.length;

  return index > 0 && insideExtension ? segments[index + 1] : undefined;
};

// src/extensions/index.ts loads every extension, so importing it crosses every boundary at once.
const isCompositionRoot = (path: string): boolean =>
  /(^|\/)src\/extensions(\/index(\.[jt]s)?)?$/.test(path);

export const extensionBoundaryRule: Rule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      crossing:
        'Extension "{{source}}" must not import from extension "{{target}}". Move shared code under src/.',
      root: 'Extension "{{source}}" must not import src/extensions/index.ts, which loads every extension.',
    },
  },
  create(context) {
    const source = extensionOf(context.filename);

    if (source === undefined) {
      return {};
    }

    const check = (node: ESTree.Node, specifier: unknown) => {
      if (typeof specifier !== 'string' || !specifier.startsWith('.')) {
        return;
      }

      const directory = posix.dirname(context.filename.replaceAll('\\', '/'));
      const resolved = posix.join(directory, specifier);
      const target = extensionOf(resolved);

      if (isCompositionRoot(resolved)) {
        context.report({ node, messageId: 'root', data: { source } });
      } else if (target !== undefined && target !== source) {
        context.report({ node, messageId: 'crossing', data: { source, target } });
      }
    };

    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        check(node, node.source?.value);
      },
      ImportExpression(node) {
        check(node, node.source.type === 'Literal' ? node.source.value : undefined);
      },
    };
  },
};
