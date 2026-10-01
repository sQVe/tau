import type { Rule } from '@oxlint/plugins';

import { isGlobalReflectMethodCall } from '../shared/reflectMethod.ts';

export const noReflectApplyRule: Rule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      reflectApply:
        'Replace `Reflect.apply` with a typed function call. Put dynamic dispatch behind a named interface.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isGlobalReflectMethodCall(context.sourceCode, node, 'apply')) {
          context.report({ node, messageId: 'reflectApply' });
        }
      },
    };
  },
};
