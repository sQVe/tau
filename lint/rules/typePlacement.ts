import type { ESTree, Rule, SourceCode } from '@oxlint/plugins';

type TypeDeclaration = ESTree.TSTypeAliasDeclaration | ESTree.TSInterfaceDeclaration;

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

// Where a statement starts once the comment lines directly above it are counted with it. Code
// before it on the same line stays out.
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

  const sharesLine = sourceCode.getTokenBefore(first)?.loc.end.line === first.loc.start.line;

  return sharesLine ? first.range[0] : first.range[0] - first.loc.start.column;
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

export const typePlacementRule: Rule = {
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
};
