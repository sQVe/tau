import type {
  ArrowFunctionExpression,
  BindingPattern,
  BindingRestElement,
  BlockStatement,
  Expression,
  Function,
  MemberExpression,
  ParamPattern,
  Program,
  Statement,
  TSParameterProperty,
  VariableDeclaration,
} from 'oxc-parser';

type BindingKind = 'escaping' | 'function' | 'local';

interface BindingScope {
  bindings: Map<string, BindingKind>;
  functionScope: boolean;
}

interface WrappedExpression {
  readonly expression: Expression;
}

export interface BindingScopes {
  declare: (name: string, kind: BindingKind) => void;
  declareVariable: (name: string, kind: BindingKind) => void;
  enter: (functionScope: boolean) => void;
  exit: () => void;
  kindOf: (name: string) => BindingKind | undefined;
  setLoopIterable: (node: Expression | null) => void;
  takeLoopIterable: () => Expression | null;
}

const bindingNames = (
  pattern: BindingPattern | BindingRestElement | ParamPattern | TSParameterProperty,
): string[] => {
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name];
    case 'ObjectPattern':
      return pattern.properties.flatMap((property) =>
        property.type === 'RestElement'
          ? bindingNames(property.argument)
          : bindingNames(property.value),
      );
    case 'ArrayPattern':
      return pattern.elements.flatMap((element) => (element === null ? [] : bindingNames(element)));
    case 'AssignmentPattern':
      return bindingNames(pattern.left);
    case 'RestElement':
      return bindingNames(pattern.argument);
    case 'TSParameterProperty':
      return bindingNames(pattern.parameter);
    default:
      return [];
  }
};

export const importedBindings = (program: Program): Set<string> =>
  new Set(
    program.body.flatMap((node) => {
      if (node.type !== 'ImportDeclaration') {
        return [];
      }

      return node.specifiers.map((specifier) => specifier.local.name);
    }),
  );

export const createBindingScopes = (): BindingScopes => {
  const scopes: BindingScope[] = [{ bindings: new Map(), functionScope: true }];
  let loopIterable: Expression | null = null;

  const currentScope = (): BindingScope => {
    const scope = scopes.at(-1);

    if (scope === undefined) {
      throw new Error('the binding scope stack is empty');
    }

    return scope;
  };

  const declare = (name: string, kind: BindingKind): void => {
    currentScope().bindings.set(name, kind);
  };

  // A `var` belongs to the nearest function, not to the block that declares it.
  const declareVariable = (name: string, kind: BindingKind): void => {
    const scope = scopes.findLast((candidate) => candidate.functionScope);

    if (scope === undefined) {
      throw new Error('a var has no enclosing function scope');
    }

    scope.bindings.set(name, kind);
  };

  const enter = (functionScope: boolean): void => {
    scopes.push({ bindings: new Map(), functionScope });
  };

  const exit = (): void => {
    if (scopes.length === 1) {
      throw new Error('the binding scope stack would empty');
    }

    scopes.pop();
  };

  // The innermost binding wins, so a local that shadows an import or a parameter does not escape.
  const kindOf = (name: string): BindingKind | undefined => {
    for (const scope of scopes.toReversed()) {
      const kind = scope.bindings.get(name);

      if (kind !== undefined) {
        return kind;
      }
    }

    return undefined;
  };

  // A `for...of`/`for...in` head declares its binding from the iterable, so the kind is set just
  // before the head's declaration is read.
  const setLoopIterable = (node: Expression | null): void => {
    loopIterable = node;
  };

  const takeLoopIterable = (): Expression | null => {
    const node = loopIterable;

    loopIterable = null;

    return node;
  };

  return { declare, declareVariable, enter, exit, kindOf, setLoopIterable, takeLoopIterable };
};

// A TypeScript-only wrapper is erased at compile time, so it does not change the value's kind.
const wrapperTypes = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'TSNonNullExpression',
]);

const isWrappedExpression = (node: Expression): node is Expression & WrappedExpression =>
  wrapperTypes.has(node.type);

const unwrapExpression = (node: Expression): Expression =>
  isWrappedExpression(node) ? unwrapExpression(node.expression) : node;

const isFunctionExpression = (node: Expression | null): boolean => {
  if (node === null) {
    return false;
  }

  const value = unwrapExpression(node);

  return (
    value.type === 'ArrowFunctionExpression' ||
    value.type === 'FunctionExpression' ||
    value.type === 'ClassExpression'
  );
};

// The declaration a statement carries, whether or not it is exported.
const declaredStatement = (statement: Statement) => {
  const isExport =
    statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration';

  return isExport ? statement.declaration : statement;
};

// A function or class declaration is hoisted to the top of its scope for this rule, so a later
// assignment still sees it. The rule is call-agnostic, so it does not model the class TDZ.
const declarationNames = (statements: readonly Statement[]): string[] =>
  statements.flatMap((statement) => {
    const declaration = declaredStatement(statement);

    const isNamedDeclaration =
      declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration';

    if (isNamedDeclaration && declaration.id !== null) {
      return [declaration.id.name];
    }

    return [];
  });

// A function-valued variable is also known at scope entry, so a closure declared before it still
// reports the escape.
const variableFunctionNames = (statements: readonly Statement[]): string[] =>
  statements.flatMap((statement) => {
    const declaration = declaredStatement(statement);

    if (declaration?.type !== 'VariableDeclaration') {
      return [];
    }

    return declaration.declarations.flatMap((declarator) =>
      declarator.id.type === 'Identifier' && isFunctionExpression(declarator.init)
        ? [declarator.id.name]
        : [],
    );
  });

export const declareFunctions = (
  bindings: BindingScopes,
  statements: readonly Statement[],
): void => {
  for (const name of [...declarationNames(statements), ...variableFunctionNames(statements)]) {
    bindings.declare(name, 'function');
  }
};

const globalObjects = new Set(['global', 'globalThis', 'process', 'self', 'window']);

const rootName = (node: Expression): string | undefined => {
  const value = unwrapExpression(node);

  if (value.type === 'Identifier') {
    return value.name;
  }

  return value.type === 'MemberExpression' ? rootName(value.object) : undefined;
};

export const isEscapingObject = (bindings: BindingScopes, node: MemberExpression): boolean => {
  const name = rootName(node.object);

  if (name === undefined) {
    return false;
  }

  const kind = bindings.kindOf(name);
  const isGlobal = kind === undefined && globalObjects.has(name);

  return kind === 'escaping' || isGlobal;
};

export const isFunctionValue = (bindings: BindingScopes, node: Expression | null): boolean => {
  if (node === null) {
    return false;
  }

  if (isFunctionExpression(node)) {
    return true;
  }

  const value = unwrapExpression(node);

  return value.type === 'Identifier' && bindings.kindOf(value.name) === 'function';
};

// A plain identifier initializer carries its binding's kind, so an alias of an imported or parameter
// object still escapes when a property of the alias is assigned. A member of an escaping object
// carries the object's kind too, so `const api = request.api` still escapes. A TypeScript-only
// wrapper is erased, so it does not change the kind.
const isEscapingAlias = (bindings: BindingScopes, node: Expression | null): boolean => {
  if (node === null) {
    return false;
  }

  const value = unwrapExpression(node);

  if (value.type === 'MemberExpression') {
    return isEscapingObject(bindings, value);
  }

  return value.type === 'Identifier' && bindings.kindOf(value.name) === 'escaping';
};

const aliasKind = (bindings: BindingScopes, node: Expression | null): BindingKind => {
  if (isFunctionValue(bindings, node)) {
    return 'function';
  }

  return isEscapingAlias(bindings, node) ? 'escaping' : 'local';
};

export const enterFunctionScope = (
  bindings: BindingScopes,
  node: Function | ArrowFunctionExpression,
): void => {
  bindings.enter(true);

  for (const name of node.params.flatMap(bindingNames)) {
    bindings.declare(name, 'escaping');
  }
};

export const enterBlockScope = (bindings: BindingScopes, node: BlockStatement): void => {
  bindings.enter(false);
  declareFunctions(bindings, node.body);
};

export const declareVariables = (bindings: BindingScopes, node: VariableDeclaration): void => {
  const declareName = node.kind === 'var' ? bindings.declareVariable : bindings.declare;

  for (const declarator of node.declarations) {
    const initializer = declarator.init ?? bindings.takeLoopIterable();

    // A pattern binds properties of the initializer, such as a number from a function's `length`.
    // Only an escaping initializer passes its kind on, so `const { api } = request` still escapes.
    const patternKind = isEscapingAlias(bindings, initializer) ? 'escaping' : 'local';

    const kind =
      declarator.id.type === 'Identifier' ? aliasKind(bindings, initializer) : patternKind;

    for (const name of bindingNames(declarator.id)) {
      declareName(name, kind);
    }
  }
};
