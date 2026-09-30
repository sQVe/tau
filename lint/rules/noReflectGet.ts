import type { Rule } from '@oxlint/plugins';

import { isGlobalReflectMethodCall } from '../shared/reflectMethod.ts';

export const noReflectGetRule: Rule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      reflectGet:
        'Replace `Reflect.get` with typed property access. Parse dynamic input into a named type before reading it.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isGlobalReflectMethodCall(context.sourceCode, node, 'get')) {
          context.report({ node, messageId: 'reflectGet' });
        }
      },
    };
  },
};
