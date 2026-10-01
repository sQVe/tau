import type { ESTree, Rule } from '@oxlint/plugins';

import { isWrappedExpression } from '../shared/wrappedExpression.ts';

export const helperBeforeUseRule: Rule = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: { order: 'Define helper "{{name}}" before its callers.' },
  },
  create(context) {
    const checkReferences = (node: ESTree.Node) => {
      for (const variable of context.sourceCode.getDeclaredVariables(node)) {
        for (const reference of variable.references) {
          let name: ESTree.Node = reference.identifier;

          while (name.parent.type === 'TSQualifiedName') {
            name = name.parent;
          }

          if (name.parent.type === 'TSTypeQuery') {
            continue;
          }

          if (reference.isRead() && reference.identifier.range[0] < node.range[0]) {
            context.report({
              node: reference.identifier,
              messageId: 'order',
              data: { name: variable.name },
            });
          }
        }
      }
    };

    return {
      FunctionDeclaration: checkReferences,
      // Infer only function syntax; factory-returned helpers need type-aware lint.
      VariableDeclarator(node) {
        let initializer = node.init;

        if (!initializer) {
          return;
        }

        while (isWrappedExpression(initializer)) {
          initializer = initializer.expression;
        }

        const definesFunction =
          initializer.type === 'ArrowFunctionExpression' ||
          initializer.type === 'FunctionExpression';

        if (node.id.type === 'Identifier' && definesFunction) {
          checkReferences(node);
        }
      },
    };
  },
};
