import type { ESTree, Rule } from '@oxlint/plugins';

import { createTypeAliasEnvironment, resolvedTypeMatches } from '../shared/typeAliasResolution.ts';
import type { TypeAliasEnvironment } from '../shared/typeAliasResolution.ts';

const isUnknownType = (
  type: ESTree.TSType,
  matches: (child: ESTree.TSType) => boolean,
): boolean => {
  if (type.type === 'TSParenthesizedType') {
    return matches(type.typeAnnotation);
  }

  if (type.type === 'TSUnionType') {
    return type.types.some(matches);
  }

  return type.type === 'TSUnknownKeyword';
};

export const noUnknownTypeAliasesRule: Rule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      unknownAlias:
        'Type alias `{{alias}}` hides `unknown`. Keep `unknown` visible at the parsing boundary, or use the parsed type.',
    },
  },
  create(context) {
    let environment: TypeAliasEnvironment | undefined;

    return {
      Program(program) {
        environment = createTypeAliasEnvironment(program, context.sourceCode.visitorKeys);
      },
      TSTypeAliasDeclaration(node) {
        const resolvesToUnknown =
          environment !== undefined &&
          resolvedTypeMatches(node.typeAnnotation, environment, isUnknownType);

        if (resolvesToUnknown) {
          context.report({
            node: node.id,
            messageId: 'unknownAlias',
            data: { alias: node.id.name },
          });
        }
      },
    };
  },
};
