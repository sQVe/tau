import { posix } from 'node:path';

import type { Definition, ESTree, Plugin, SourceCode, Variable } from '@oxlint/plugins';

type WrappedExpression =
  | ESTree.TSAsExpression
  | ESTree.TSSatisfiesExpression
  | ESTree.TSTypeAssertion
  | ESTree.TSNonNullExpression
  | ESTree.ParenthesizedExpression;

type TypeDeclaration = ESTree.TSTypeAliasDeclaration | ESTree.TSInterfaceDeclaration;

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

const declarationOf = (statement: ESTree.Node): ESTree.Node => {
  if (statement.type === 'ExportNamedDeclaration') {
    return statement.declaration ?? statement;
  }

  const defaultInterface =
    statement.type === 'ExportDefaultDeclaration' &&
    statement.declaration.type === 'TSInterfaceDeclaration';

  return defaultInterface ? statement.declaration : statement;
};

const typeDeclarationOf = (statement: ESTree.Node): TypeDeclaration | undefined => {
  const declaration = declarationOf(statement);

  const isType =
    declaration.type === 'TSTypeAliasDeclaration' || declaration.type === 'TSInterfaceDeclaration';

  return isType ? declaration : undefined;
};

const isReExport = (statement: ESTree.Node): boolean =>
  statement.type === 'ExportNamedDeclaration' && statement.source !== null;

// Imports and re-exports head the module; a type below them is not below a value.
const isModuleHeader = (statement: ESTree.Node): boolean =>
  statement.type === 'ImportDeclaration' ||
  statement.type === 'ExportAllDeclaration' ||
  isReExport(statement);

const topLevelStatementOf = (node: ESTree.Node): ESTree.Node => {
  let statement = node;

  while (statement.parent !== null && statement.parent.type !== 'Program') {
    statement = statement.parent;
  }

  return statement;
};

const rootNameOf = (name: ESTree.TSTypeQueryExprName): string | undefined => {
  if (name.type === 'TSQualifiedName') {
    return rootNameOf(name.left);
  }

  return name.type === 'Identifier' ? name.name : undefined;
};

// Where a statement starts once the comment lines directly above it are counted with it.
const lineStartWithComments = (statement: ESTree.Node, sourceCode: SourceCode): number => {
  let first: ESTree.Span = statement;
  const comments = sourceCode.getCommentsBefore(statement);

  for (const comment of comments.toReversed()) {
    const previous = sourceCode.getTokenBefore(comment);
    const trailsPrevious = previous?.loc.end.line === comment.loc.start.line;

    if (trailsPrevious || comment.loc.end.line + 1 < first.loc.start.line) {
      break;
    }

    first = comment;
  }

  return first.range[0] - first.loc.start.column;
};

const moduleValues = (program: ESTree.Program, sourceCode: SourceCode) => {
  const names = new Set<string>();
  let first: ESTree.Node | undefined;

  for (const statement of program.body) {
    if (isModuleHeader(statement) || typeDeclarationOf(statement) !== undefined) {
      continue;
    }

    first ??= statement;

    for (const variable of sourceCode.getDeclaredVariables(declarationOf(statement))) {
      names.add(variable.name);
    }
  }

  return { names, first };
};

// A type that applies `typeof` to a value in this module mirrors that value and stays beside it.
const misplacedTypes = (
  program: ESTree.Program,
  sourceCode: SourceCode,
  typeQueries: Map<ESTree.Node, string[]>,
) => {
  const values = moduleValues(program, sourceCode);

  if (values.first === undefined) {
    return undefined;
  }

  const insertAt = lineStartWithComments(values.first, sourceCode);
  const types: { declaration: TypeDeclaration; range: [number, number] }[] = [];

  for (const statement of program.body) {
    const declaration = typeDeclarationOf(statement);
    const derived = typeQueries.get(statement)?.some((name) => values.names.has(name)) ?? false;

    if (declaration === undefined || statement.range[0] < insertAt || derived) {
      continue;
    }

    // Code after the type on its line stays put; otherwise the whole line goes.
    const next = sourceCode.getTokenAfter(statement);
    const lineEnd = sourceCode.text.indexOf('\n', statement.range[1]);
    const sharesLine = next !== null && next.loc.start.line === statement.loc.end.line;
    const end = lineEnd === -1 ? sourceCode.text.length : lineEnd + 1;

    types.push({
      declaration,
      range: [lineStartWithComments(statement, sourceCode), sharesLine ? next.range[0] : end],
    });
  }

  return { insertAt, types };
};

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
    'type-placement': {
      meta: {
        type: 'suggestion',
        fixable: 'code',
        schema: [],
        messages: {
          placement:
            'Declare "{{names}}" below the imports, above values. Only types that use `typeof` on a value here may follow it.',
        },
      },
      create(context) {
        const { sourceCode } = context;
        const typeQueries = new Map<ESTree.Node, string[]>();

        return {
          TSTypeQuery(node) {
            const name = rootNameOf(node.exprName);
            const statement = topLevelStatementOf(node);

            if (name !== undefined) {
              typeQueries.set(statement, [...(typeQueries.get(statement) ?? []), name]);
            }
          },
          'Program:exit'(program) {
            const placement = misplacedTypes(program, sourceCode, typeQueries);
            const [first] = placement?.types ?? [];

            if (placement === undefined || first === undefined) {
              return;
            }

            const { insertAt, types } = placement;

            const moved = types
              .map(({ range }) => `${sourceCode.text.slice(...range).trimEnd()}\n\n`)
              .join('');

            const names = types.map(({ declaration }) => declaration.id.name).join('", "');

            // One report per file: Oxlint applies fixes in a single pass and skips overlapping ones.
            context.report({
              node: first.declaration.id,
              messageId: 'placement',
              data: { names },
              fix: (fixer) => [
                fixer.insertTextBeforeRange([insertAt, insertAt], moved),
                ...types.map(({ range }) => fixer.removeRange(range)),
              ],
            });
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
