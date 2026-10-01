import type { Rule } from '@oxlint/plugins';

const isErrorsModule = (filename: string): boolean =>
  filename.replaceAll('\\', '/').endsWith('/src/errors/index.ts');

export const noEnoentLiteralRule: Rule = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: { literal: "Use isMissingFile from src/errors instead of comparing 'ENOENT'." },
  },
  create(context) {
    if (isErrorsModule(context.filename) || context.filename.endsWith('.test.ts')) {
      return {};
    }

    return {
      Literal(node) {
        // oxlint-disable-next-line tau/no-enoent-literal -- The rule matches this literal.
        if (node.value === 'ENOENT') {
          context.report({ node, messageId: 'literal' });
        }
      },
    };
  },
};
