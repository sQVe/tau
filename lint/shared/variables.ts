import type { ESTree, Scope, SourceCode, Variable } from '@oxlint/plugins';

type Identifier = Extract<ESTree.Node, { type: 'Identifier' }>;

interface ConstBinding {
  declarator: ESTree.VariableDeclarator;
  initializer: ESTree.Expression;
}

export const resolveVariable = (
  sourceCode: SourceCode,
  identifier: Identifier,
): Variable | undefined => {
  let scope: Scope | null = sourceCode.getScope(identifier);

  while (scope !== null) {
    const variable = scope.set.get(identifier.name);

    if (variable !== undefined) {
      return variable;
    }

    scope = scope.upper;
  }

  return undefined;
};

// A name Oxlint cannot resolve, or one declared nowhere in the file, is the global binding.
export const isGlobalName = (sourceCode: SourceCode, identifier: Identifier): boolean => {
  const variable = resolveVariable(sourceCode, identifier);

  return variable === undefined || variable.defs.length === 0;
};

export const isReassigned = (variable: Variable): boolean =>
  variable.references.some((reference) => reference.isWrite() && !reference.init);

const isConstDeclarator = (declarator: ESTree.VariableDeclarator): boolean =>
  declarator.parent.type === 'VariableDeclaration' && declarator.parent.kind === 'const';

// The declarator and value of a `const name = value` binding that is never assigned again.
export const constBinding = (variable: Variable): ConstBinding | undefined => {
  if (isReassigned(variable)) {
    return undefined;
  }

  for (const definition of variable.defs) {
    const declarator = definition.node;

    if (declarator.type !== 'VariableDeclarator' || declarator.id.type !== 'Identifier') {
      continue;
    }

    if (isConstDeclarator(declarator) && declarator.init !== null) {
      return { declarator, initializer: declarator.init };
    }
  }

  return undefined;
};
