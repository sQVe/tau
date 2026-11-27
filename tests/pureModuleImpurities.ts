import { posix } from 'node:path';

import { parseSync, Visitor } from 'oxc-parser';
import type {
  CallExpression,
  MemberExpression,
  ModuleDeclaration,
  NewExpression,
  VisitorObject,
} from 'oxc-parser';

import { pureLibraries } from './pureModuleRegistry.js';
import {
  createBindingScopes,
  declareFunctions,
  declareVariables,
  enterBlockScope,
  enterFunctionScope,
  importedBindings,
  isEscapingObject,
  isFunctionValue,
} from './pureModuleScopes.js';
import type { BindingScopes } from './pureModuleScopes.js';

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
    ForOfStatement: (node) => {
      const iterable = node.left.type === 'VariableDeclaration' ? node.right : null;

      bindings.setLoopIterable(iterable);
    },
    ForInStatement: (node) => {
      const iterable = node.left.type === 'VariableDeclaration' ? node.right : null;

      bindings.setLoopIterable(iterable);
    },
    SwitchStatement: (node) => {
      // The switch body is one lexical block, so a class or function declared in a case is visible
      // in the other cases but not after the switch.
      bindings.enter(false);

      for (const switchCase of node.cases) {
        declareFunctions(bindings, switchCase.consequent);
      }
    },
    'SwitchStatement:exit': bindings.exit,
    StaticBlock: (node) => {
      bindings.enter(true);
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
