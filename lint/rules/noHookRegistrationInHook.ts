import type { Rule } from '@oxlint/plugins';

const hookNames = new Set(['beforeAll', 'beforeEach', 'afterEach']);

const hasType = (value: unknown): value is { type: string } => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return 'type' in value && typeof value.type === 'string';
};

const isHookCall = (value: unknown): boolean => {
  if (!hasType(value) || value.type !== 'CallExpression' || !('callee' in value)) {
    return false;
  }

  const callee = value.callee;

  if (!hasType(callee) || callee.type !== 'Identifier' || !('name' in callee)) {
    return false;
  }

  return typeof callee.name === 'string' && hookNames.has(callee.name);
};

export const noHookRegistrationInHookRule: Rule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      nested:
        'Register afterAll at suite definition time. Vitest ignores it when it runs inside another hook.',
    },
  },
  create(context) {
    return {
      Identifier(node) {
        if (node.name !== 'afterAll') {
          return;
        }

        const nested = context.sourceCode.getAncestors(node).some(isHookCall);

        if (nested) {
          context.report({ node, messageId: 'nested' });
        }
      },
    };
  },
};
