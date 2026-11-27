import { posix } from 'node:path';

import { parseSync, Visitor } from 'oxc-parser';
import type {
  ArrowFunctionExpression,
  BindingPattern,
  BindingRestElement,
  BlockStatement,
  CallExpression,
  Expression,
  Function,
  MemberExpression,
  ModuleDeclaration,
  NewExpression,
  ParamPattern,
  Program,
  Statement,
  TSParameterProperty,
  VariableDeclaration,
  VisitorObject,
} from 'oxc-parser';

import { pureLibraries } from './pureModuleRegistry.js';

type BindingKind = 'escaping' | 'function' | 'local';

interface BindingScope {
  bindings: Map<string, BindingKind>;
  functionScope: boolean;
}

interface WrappedExpression {
  readonly expression: Expression;
}

const effectMembers = new Set(['Date.now', 'Math.random', 'performance.now', 'process.env']);

// Reads `Date.now` and `Date['now']` alike.
export const propertyKey = ({ computed, property }: MemberExpression): string | undefined => {
  if (property.type === 'Identifier' && !computed) {
    return property.name;
  }

  if (property.type === 'TemplateLiteral' && property.expressions.length === 0) {
    return property.quasis[0]?.value.cooked ?? undefined;
  }

  return property.type === 'Literal' && typeof property.value === 'string'
    ? property.value
    : undefined;
};

export const memberName = (node: MemberExpression): string | undefined => {
  const key = propertyKey(node);

  return node.object.type === 'Identifier' && key !== undefined
    ? `${node.object.name}.${key}`
    : undefined;
};

// Inline `{ type X }` specifiers still load the module under verbatimModuleSyntax, so only a
// top-level `import type` or `export type` is type-only.
const isTypeOnly = (node: ModuleDeclaration) => {
  const typeImport = 'importKind' in node && node.importKind === 'type';
  const typeExport = 'exportKind' in node && node.exportKind === 'type';

  return typeImport || typeExport;
};

export const findingLines = (found: string[]): number[] =>
  found.map((finding) => Number(finding.split(':')[1]));

const isPureLibrary = (path: string, specifier: string) =>
  pureLibraries[path]?.includes(specifier) ?? false;

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

const importedBindings = (program: Program): Set<string> =>
  new Set(
    program.body.flatMap((node) => {
      if (node.type !== 'ImportDeclaration') {
        return [];
      }

      return node.specifiers.map((specifier) => specifier.local.name);
    }),
  );

const createBindingScopes = () => {
  const scopes: BindingScope[] = [{ bindings: new Map(), functionScope: true }];

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

  return { declare, declareVariable, enter, exit, kindOf };
};

type BindingScopes = ReturnType<typeof createBindingScopes>;

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

const declareFunctions = (bindings: BindingScopes, statements: readonly Statement[]): void => {
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

const isEscapingObject = (bindings: BindingScopes, node: MemberExpression): boolean => {
  const name = rootName(node.object);

  if (name === undefined) {
    return false;
  }

  const kind = bindings.kindOf(name);
  const isGlobal = kind === undefined && globalObjects.has(name);

  return kind === 'escaping' || isGlobal;
};

const isFunctionValue = (bindings: BindingScopes, node: Expression | null): boolean => {
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
// object still escapes when a property of the alias is assigned. A TypeScript-only wrapper is
// erased, so it does not change the kind.
const isEscapingAlias = (bindings: BindingScopes, node: Expression | null): boolean => {
  if (node === null) {
    return false;
  }

  const value = unwrapExpression(node);

  return value.type === 'Identifier' && bindings.kindOf(value.name) === 'escaping';
};

const aliasKind = (bindings: BindingScopes, node: Expression | null): BindingKind => {
  if (isFunctionValue(bindings, node)) {
    return 'function';
  }

  return isEscapingAlias(bindings, node) ? 'escaping' : 'local';
};

const enterFunctionScope = (
  bindings: BindingScopes,
  node: Function | ArrowFunctionExpression,
): void => {
  bindings.enter(true);

  for (const name of node.params.flatMap(bindingNames)) {
    bindings.declare(name, 'escaping');
  }
};

const enterBlockScope = (bindings: BindingScopes, node: BlockStatement): void => {
  bindings.enter(false);
  declareFunctions(bindings, node.body);
};

const declareVariables = (bindings: BindingScopes, node: VariableDeclaration): void => {
  const declareName = node.kind === 'var' ? bindings.declareVariable : bindings.declare;

  for (const declarator of node.declarations) {
    // A pattern binds properties of the initializer, such as a number from a function's `length`.
    // Only an escaping initializer passes its kind on, so `const { api } = request` still escapes.
    const patternKind = isEscapingAlias(bindings, declarator.init) ? 'escaping' : 'local';

    const kind =
      declarator.id.type === 'Identifier' ? aliasKind(bindings, declarator.init) : patternKind;

    for (const name of bindingNames(declarator.id)) {
      declareName(name, kind);
    }
  }
};

const checkImport = (
  path: string,
  registry: readonly string[],
  node: ModuleDeclaration,
  at: (offset: number, what: string) => void,
): void => {
  const specifier = 'source' in node ? node.source?.value : undefined;

  if (specifier === undefined || isTypeOnly(node)) {
    return;
  }

  const target = posix.join(posix.dirname(path), specifier).replace(/\.js$/, '.ts');

  if (isPureLibrary(path, specifier)) {
    return;
  }

  if (!specifier.startsWith('.') || !registry.includes(target)) {
    at(node.start, `runtime import of ${specifier}`);
  }
};

// `Date()` returns the current time as a string.
const callProblem = (node: CallExpression): string | undefined => {
  const callee = node.callee.type === 'Identifier' ? node.callee.name : undefined;

  return callee === 'require' || callee === 'Date' ? `${callee}()` : undefined;
};

const isCurrentDate = (node: NewExpression): boolean =>
  node.callee.type === 'Identifier' && node.callee.name === 'Date' && node.arguments.length === 0;

const effectVisitors = (
  bindings: BindingScopes,
  at: (offset: number, what: string) => void,
): VisitorObject => ({
  AssignmentExpression: (node) => {
    // A function assigned to a property of a parameter, an imported binding, or a global escapes
    // the module, so the rule counts it as an effect.
    const escapes = node.left.type === 'MemberExpression' && isEscapingObject(bindings, node.left);

    if (escapes && isFunctionValue(bindings, node.right)) {
      at(node.start, 'assigns a function to a property');
    }
  },
  CallExpression: (node) => {
    const problem = callProblem(node);

    if (problem !== undefined) {
      at(node.start, problem);
    }
  },
  NewExpression: (node) => {
    if (isCurrentDate(node)) {
      at(node.start, 'new Date()');
    }
  },
  MemberExpression: (node) => {
    const name = memberName(node);

    if (name !== undefined && effectMembers.has(name)) {
      at(node.start, name);
    }
  },
});

// Lists each runtime import outside the registry, dynamic load, and effect in a registered module.
export const impurities = (path: string, source: string, registry: readonly string[]): string[] => {
  const found: string[] = [];
  const program = parseSync(path, source).program;
  const bindings = createBindingScopes();

  const at = (offset: number, what: string) => {
    const lineNumber = source.slice(0, offset).split('\n').length;

    return found.push(`${path}:${lineNumber}: ${what}`);
  };

  for (const name of importedBindings(program)) {
    bindings.declare(name, 'escaping');
  }

  declareFunctions(bindings, program.body);

  new Visitor({
    FunctionDeclaration: (node) => {
      enterFunctionScope(bindings, node);
    },
    'FunctionDeclaration:exit': bindings.exit,
    FunctionExpression: (node) => {
      enterFunctionScope(bindings, node);
    },
    'FunctionExpression:exit': bindings.exit,
    TSDeclareFunction: (node) => {
      enterFunctionScope(bindings, node);
    },
    'TSDeclareFunction:exit': bindings.exit,
    TSEmptyBodyFunctionExpression: (node) => {
      enterFunctionScope(bindings, node);
    },
    'TSEmptyBodyFunctionExpression:exit': bindings.exit,
    ArrowFunctionExpression: (node) => {
      enterFunctionScope(bindings, node);
    },
    'ArrowFunctionExpression:exit': bindings.exit,
    BlockStatement: (node) => {
      enterBlockScope(bindings, node);
    },
    'BlockStatement:exit': bindings.exit,
    VariableDeclaration: (node) => {
      declareVariables(bindings, node);
    },
    SwitchCase: (node) => {
      // A class or function declared in a case is hoisted to the switch's block, so an assignment
      // later in the same case still sees it.
      for (const name of declarationNames(node.consequent)) {
        bindings.declare(name, 'function');
      }
    },
    StaticBlock: (node) => {
      bindings.enter(false);
      declareFunctions(bindings, node.body);
    },
    'StaticBlock:exit': bindings.exit,
    ImportDeclaration: (node) => {
      checkImport(path, registry, node, at);
    },
    ExportNamedDeclaration: (node) => {
      checkImport(path, registry, node, at);
    },
    ExportAllDeclaration: (node) => {
      checkImport(path, registry, node, at);
    },
    ImportExpression: (node) => at(node.start, 'dynamic import'),
    ...effectVisitors(bindings, at),
  }).visit(program);

  return found;
};

export const purityProblems = (
  modules: readonly string[],
  exceptions: Readonly<Record<string, readonly string[]>>,
  readSource: (path: string) => string,
): string[] => {
  const problems = modules.flatMap((path) => {
    const findings = impurities(path, readSource(path), modules);
    const reasons = exceptions[path];

    if (reasons === undefined) {
      return findings;
    }

    const remaining = [...findings];
    const unmatched: string[] = [];

    for (const reason of reasons) {
      const matches = remaining.filter((finding) => finding.endsWith(`: ${reason}`));
      const [match] = matches;

      if (match === undefined) {
        unmatched.push(`${path}: unused exception ${reason}`);

        continue;
      }

      if (matches.length > 1) {
        unmatched.push(`${path}: exception ${reason} matches ${matches.length} findings`);

        continue;
      }

      remaining.splice(remaining.indexOf(match), 1);
    }

    return [...remaining, ...unmatched];
  });

  const unregistered = Object.keys(exceptions)
    .filter((path) => !modules.includes(path))
    .map((path) => `${path}: exception for an unregistered module`);

  return [...problems, ...unregistered];
};
