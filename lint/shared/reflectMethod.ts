import type { ESTree, SourceCode } from '@oxlint/plugins';

import { staticPropertyName } from './memberExpressions.ts';
import { isGlobalName } from './variables.ts';

const isGlobalReflect = (sourceCode: SourceCode, expression: ESTree.Expression): boolean => {
  if (expression.type !== 'Identifier' || expression.name !== 'Reflect') {
    return false;
  }

  return sourceCode.isGlobalReference(expression) || isGlobalName(sourceCode, expression);
};

export const isGlobalReflectMethodCall = (
  sourceCode: SourceCode,
  call: ESTree.CallExpression,
  methodName: string,
): boolean => {
  const { callee } = call;

  if (callee.type !== 'MemberExpression' || !isGlobalReflect(sourceCode, callee.object)) {
    return false;
  }

  return staticPropertyName(callee) === methodName;
};
