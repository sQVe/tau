import type { ESTree, Rule } from '@oxlint/plugins';

import { isWrappedExpression } from '../shared/wrappedExpression.ts';

const isCondition = (node: ESTree.Node): node is ESTree.LogicalExpression =>
  node.type === 'LogicalExpression' && node.operator !== '??';

const isNegation = (node: ESTree.Node): node is ESTree.UnaryExpression =>
  node.type === 'UnaryExpression' && node.operator === '!';

const collectOperators = (node: ESTree.Node, operators: string[]) => {
  if (isWrappedExpression(node)) {
    return collectOperators(node.expression, operators);
  }

  if (isNegation(node)) {
    return collectOperators(node.argument, operators);
  }

  if (!isCondition(node)) {
    return operators;
  }

  operators.push(node.operator);
  collectOperators(node.left, operators);
  collectOperators(node.right, operators);

  return operators;
};

export const maxConditionChecksRule: Rule = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: {
      tooMany: 'This condition joins {{count}} checks. Join at most 3 and name the rest.',
      mixed: 'This condition mixes && and ||. Name the inner group first.',
    },
  },
  create(context) {
    return {
      LogicalExpression(node) {
        if (!isCondition(node)) {
          return;
        }

        let parent = node.parent;

        while (isWrappedExpression(parent) || isNegation(parent)) {
          parent = parent.parent;
        }

        if (isCondition(parent)) {
          return;
        }

        const operators = collectOperators(node, []);
        const count = operators.length + 1;

        if (new Set(operators).size > 1) {
          context.report({ node, messageId: 'mixed' });
        }

        if (count > 3) {
          context.report({ node, messageId: 'tooMany', data: { count: String(count) } });
        }
      },
    };
  },
};
