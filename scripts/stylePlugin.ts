import { posix } from 'node:path';

import type { Definition, ESTree, Plugin, Variable } from '@oxlint/plugins';

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

const isWrappedExpression = (node: ESTree.Node): node is WrappedExpression =>
  wrappedExpressionTypes.has(node.type);

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

const isUnusedMarker = (definition: Definition, variable: Variable): boolean => {
  if (!definition.name.name.startsWith('_')) {
    return false;
  }

  if (variable.references.some((reference) => reference.isRead())) {
    return false;
  }

  if (definition.type === 'Parameter') {
    return true;
  }

  return definition.node.type === 'VariableDeclarator' && definition.node.id.type !== 'Identifier';
};

const isErrorsModule = (filename: string): boolean =>
  filename.replaceAll('\\', '/').endsWith('/src/errors/index.ts');

// The extension directory a path belongs to; src/extensions/index.ts composes them and has none.
const extensionOf = (path: string): string | undefined => {
  const segments = path.replaceAll('\\', '/').split('/');
  const index = segments.lastIndexOf('extensions');
  const insideExtension = segments[index - 1] === 'src' && index + 2 < segments.length;

  return index > 0 && insideExtension ? segments[index + 1] : undefined;
};

// src/extensions/index.ts loads every extension, so importing it crosses every boundary at once.
const isCompositionRoot = (path: string): boolean =>
  /(^|\/)src\/extensions(\/index(\.[jt]s)?)?$/.test(path);

const stylePlugin: Plugin = {
  meta: { name: 'tau' },
  rules: {
    'extension-boundary': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          crossing:
            'Extension "{{source}}" must not import from extension "{{target}}". Move shared code under src/.',
          root: 'Extension "{{source}}" must not import src/extensions/index.ts, which loads every extension.',
        },
      },
      create(context) {
        const source = extensionOf(context.filename);

        if (source === undefined) {
          return {};
        }

        const check = (node: ESTree.Node, specifier: unknown) => {
          if (typeof specifier !== 'string' || !specifier.startsWith('.')) {
            return;
          }

          const directory = posix.dirname(context.filename.replaceAll('\\', '/'));
          const resolved = posix.join(directory, specifier);
          const target = extensionOf(resolved);

          if (isCompositionRoot(resolved)) {
            context.report({ node, messageId: 'root', data: { source } });
          } else if (target !== undefined && target !== source) {
            context.report({ node, messageId: 'crossing', data: { source, target } });
          }
        };

        return {
          ImportDeclaration(node) {
            check(node, node.source.value);
          },
          ExportAllDeclaration(node) {
            check(node, node.source.value);
          },
          ExportNamedDeclaration(node) {
            check(node, node.source?.value);
          },
          ImportExpression(node) {
            check(node, node.source.type === 'Literal' ? node.source.value : undefined);
          },
        };
      },
    },
    'helper-before-use': {
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
          // ponytail: infer only function syntax; factory-returned helpers need type-aware lint.
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
    },
    'max-condition-checks': {
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
    },
    'no-enoent-literal': {
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
    },
    'naming-convention': {
      meta: {
        type: 'suggestion',
        schema: [],
        messages: { name: 'Use {{format}} for "{{name}}".' },
      },
      create(context) {
        const checkName = (
          node: ESTree.BindingIdentifier,
          format: 'camelCase' | 'PascalCase',
          name = node.name,
        ) => {
          const pattern = format === 'camelCase' ? /^[a-z][a-zA-Z0-9]*$/ : /^[A-Z][a-zA-Z0-9]*$/;

          if (!pattern.test(name)) {
            context.report({ node, messageId: 'name', data: { format, name: node.name } });
          }
        };

        const checkDefinition = (
          definition: Definition,
          variable: Variable,
          checked: Set<ESTree.Node>,
        ) => {
          if (
            definition.type === 'ImportBinding' ||
            definition.node.type.startsWith('TS') ||
            checked.has(definition.name)
          ) {
            return;
          }

          checked.add(definition.name);

          const unusedMarker = isUnusedMarker(definition, variable);
          const name = unusedMarker ? definition.name.name.slice(1) : definition.name.name;

          if (unusedMarker && !name) {
            return;
          }

          checkName(
            definition.name,
            definition.type === 'ClassName' ? 'PascalCase' : 'camelCase',
            name,
          );
        };

        return {
          'Program:exit'() {
            const checked = new Set<ESTree.Node>();

            for (const scope of context.sourceCode.scopeManager.scopes) {
              for (const variable of scope.variables) {
                for (const definition of variable.defs) {
                  checkDefinition(definition, variable, checked);
                }
              }
            }
          },
          TSInterfaceDeclaration(node) {
            checkName(node.id, 'PascalCase');
          },
          TSTypeAliasDeclaration(node) {
            checkName(node.id, 'PascalCase');
          },
          TSEnumDeclaration(node) {
            checkName(node.id, 'PascalCase');
          },
          TSTypeParameter(node) {
            checkName(node.name, 'PascalCase');
          },
        };
      },
    },
  },
};

export default stylePlugin;
