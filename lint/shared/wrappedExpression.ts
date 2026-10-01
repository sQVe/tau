import type { ESTree } from '@oxlint/plugins';

type WrappedExpression =
  | ESTree.TSAsExpression
  | ESTree.TSSatisfiesExpression
  | ESTree.TSTypeAssertion
  | ESTree.TSNonNullExpression
  | ESTree.ParenthesizedExpression;

const wrappedExpressionTypes = new Set<string>([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'TSNonNullExpression',
  'ParenthesizedExpression',
]);

export const isWrappedExpression = (node: ESTree.Node): node is WrappedExpression =>
  wrappedExpressionTypes.has(node.type);
