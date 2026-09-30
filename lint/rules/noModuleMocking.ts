import type { Definition, ESTree, Rule, SourceCode } from '@oxlint/plugins';

import { staticPropertyName } from '../shared/memberExpressions.ts';
import { resolveVariable } from '../shared/variables.ts';

const moduleMockMethods = new Set(['doMock', 'mock', 'unstable_mockModule']);
const frameworkNames = new Set(['vi', 'jest']);

const frameworkModules = new Map([
  ['vitest', 'vi'],
  ['@jest/globals', 'jest'],
]);

const importedName = (node: ESTree.Node): string | undefined => {
  if (node.type !== 'ImportSpecifier') {
    return undefined;
  }

  return node.imported.type === 'Identifier' ? node.imported.name : node.imported.value;
};

const importsFramework = (definition: Definition): boolean => {
  if (definition.type !== 'ImportBinding' || definition.parent?.type !== 'ImportDeclaration') {
    return false;
  }

  const name = importedName(definition.node);

  return name !== undefined && frameworkModules.get(definition.parent.source.value) === name;
};

// Globals such as Vitest's `vi` have no declaration in the file; imports must come from the framework.
const isTestFramework = (sourceCode: SourceCode, expression: ESTree.Expression): boolean => {
  if (expression.type !== 'Identifier') {
    return false;
  }

  const variable = resolveVariable(sourceCode, expression);

  if (variable === undefined || variable.defs.length === 0) {
    return frameworkNames.has(expression.name);
  }

  return variable.defs.some(importsFramework);
};

const isModuleMock = (sourceCode: SourceCode, call: ESTree.CallExpression): boolean => {
  const { callee } = call;

  if (callee.type !== 'MemberExpression' || !isTestFramework(sourceCode, callee.object)) {
    return false;
  }

  return moduleMockMethods.has(staticPropertyName(callee) ?? '');
};

export const noModuleMockingRule: Rule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      moduleMock:
        'Replace module mocking with dependency injection through a real interface or a faithful test implementation.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isModuleMock(context.sourceCode, node)) {
          context.report({ node, messageId: 'moduleMock' });
        }
      },
    };
  },
};
