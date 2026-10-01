import type { ESTree, Rule, SourceCode, Variable } from '@oxlint/plugins';

import { staticPropertyName } from '../shared/memberExpressions.ts';
import { constBinding, isGlobalName, isReassigned, resolveVariable } from '../shared/variables.ts';
import { isWrappedExpression } from '../shared/wrappedExpression.ts';

type Callback = ESTree.ArrowFunctionExpression | ESTree.Function;

interface MethodTarget {
  name: string;
  object: ESTree.Node;
}

interface Reducer {
  callback: Callback;
  accumulator: ESTree.BindingIdentifier;
  initialValue: ESTree.Node | undefined;
}

const arrayProducingMethods = new Set([
  'map',
  'filter',
  'flatMap',
  'slice',
  'concat',
  'toSorted',
  'toReversed',
  'toSpliced',
]);

const arrayTypeNames = new Set(['Array', 'ReadonlyArray']);

const arrayCopyMethods = new Set([
  'concat',
  'slice',
  'toSpliced',
  'toSorted',
  'toReversed',
  'with',
]);

const freshTargetKinds = new Set(['ArrayExpression', 'ObjectExpression']);

const unwrap = (node: ESTree.Node): ESTree.Node => {
  let current = node;

  while (isWrappedExpression(current) || current.type === 'ChainExpression') {
    current = current.expression;
  }

  return current;
};

const resolveBinding = (sourceCode: SourceCode, node: ESTree.Node): Variable | undefined => {
  const unwrapped = unwrap(node);

  return unwrapped.type === 'Identifier' ? resolveVariable(sourceCode, unwrapped) : undefined;
};

const methodTarget = (node: ESTree.Node): MethodTarget | undefined => {
  const unwrapped = unwrap(node);

  if (unwrapped.type !== 'MemberExpression') {
    return undefined;
  }

  const name = staticPropertyName(unwrapped);

  return name === undefined ? undefined : { name, object: unwrapped.object };
};

const isArrayReference = (type: ESTree.TSTypeReference): boolean =>
  type.typeName.type === 'Identifier' && arrayTypeNames.has(type.typeName.name);

const isArrayAnnotation = (type: ESTree.TSType): boolean => {
  if (type.type === 'TSArrayType' || type.type === 'TSTupleType') {
    return true;
  }

  if (type.type === 'TSParenthesizedType') {
    return isArrayAnnotation(type.typeAnnotation);
  }

  if (type.type === 'TSTypeOperator') {
    return type.operator === 'readonly' && isArrayAnnotation(type.typeAnnotation);
  }

  return type.type === 'TSTypeReference' && isArrayReference(type);
};

// A variable counts as an array only by its annotation or by a const array initializer.
const isKnownArrayVariable = (
  variable: Variable,
  visited: Set<Variable>,
  isKnownArray: (node: ESTree.Node) => boolean,
): boolean => {
  if (visited.has(variable) || isReassigned(variable)) {
    return false;
  }

  visited.add(variable);

  const annotation = variable.identifiers
    .map((identifier) => identifier.typeAnnotation?.typeAnnotation)
    .find((type) => type !== undefined);

  if (annotation !== undefined) {
    return isArrayAnnotation(annotation);
  }

  const binding = constBinding(variable);

  return binding !== undefined && isKnownArray(binding.initializer);
};

// Unknown receivers and iterator pipelines are not arrays here, so copies of them are allowed.
const isKnownArrayExpression = (sourceCode: SourceCode, node: ESTree.Node): boolean => {
  const visited = new Set<Variable>();

  const isKnownArray = (current: ESTree.Node): boolean => {
    const unwrapped = unwrap(current);

    if (unwrapped.type === 'ArrayExpression') {
      return true;
    }

    if (unwrapped.type === 'CallExpression') {
      const method = methodTarget(unwrapped.callee);

      return (
        method !== undefined &&
        arrayProducingMethods.has(method.name) &&
        isKnownArray(method.object)
      );
    }

    const variable = resolveBinding(sourceCode, unwrapped);

    return variable !== undefined && isKnownArrayVariable(variable, visited, isKnownArray);
  };

  return isKnownArray(node);
};

// The call that receives `callback` as its argument, looking through wrappers such as parentheses.
const callerOf = (callback: Callback): ESTree.CallExpression | undefined => {
  let owner: ESTree.Node | null = callback.parent;

  while (owner !== null && unwrap(owner) === callback) {
    owner = owner.parent;
  }

  return owner?.type === 'CallExpression' ? owner : undefined;
};

const isReduceCall = (call: ESTree.CallExpression, callback: Callback): boolean => {
  const name = methodTarget(call.callee)?.name;
  const [first] = call.arguments;
  const isReduce = name === 'reduce' || name === 'reduceRight';
  const passesCallback = first !== undefined && unwrap(first) === callback;

  return isReduce && call.arguments.length <= 2 && passesCallback;
};

const reducerOf = (callback: Callback): Reducer | undefined => {
  const call = callerOf(callback);

  if (call === undefined || !isReduceCall(call, callback)) {
    return undefined;
  }

  const [first] = callback.params;
  const accumulator = first?.type === 'AssignmentPattern' ? first.left : first;

  if (accumulator?.type !== 'Identifier') {
    return undefined;
  }

  return { callback, accumulator, initialValue: call.arguments[1] };
};

// Only the innermost function counts; a copy in a nested helper is not the reducer's.
const enclosingReducer = (node: ESTree.Node): Reducer | undefined => {
  let parent = node.parent;

  while (parent !== null) {
    if (parent.type === 'FunctionDeclaration') {
      return undefined;
    }

    if (parent.type === 'ArrowFunctionExpression' || parent.type === 'FunctionExpression') {
      return reducerOf(parent);
    }

    parent = parent.parent;
  }

  return undefined;
};

// Whether `node` is the accumulator or a const alias of it.
const referencesAccumulator = (
  sourceCode: SourceCode,
  node: ESTree.Node,
  accumulator: Variable,
  visited = new Set<Variable>(),
): boolean => {
  const variable = resolveBinding(sourceCode, node);

  if (variable === undefined || visited.has(variable)) {
    return false;
  }

  if (variable === accumulator) {
    return true;
  }

  visited.add(variable);

  const binding = constBinding(variable);

  return (
    binding !== undefined &&
    referencesAccumulator(sourceCode, binding.initializer, accumulator, visited)
  );
};

const isGlobalObject = (sourceCode: SourceCode, node: ESTree.Node, name: string): boolean => {
  const unwrapped = unwrap(node);

  if (unwrapped.type !== 'Identifier' || unwrapped.name !== name) {
    return false;
  }

  return isGlobalName(sourceCode, unwrapped);
};

// `Object.assign({}, accumulator)` or `Object.assign([], accumulator)` copies into a new value.
const assignsIntoFreshValue = (
  call: ESTree.CallExpression,
  isAccumulator: (node: ESTree.Node) => boolean,
): boolean => {
  const [target, ...sources] = call.arguments;
  const intoFreshValue = target !== undefined && freshTargetKinds.has(unwrap(target).type);

  return intoFreshValue && sources.some(isAccumulator);
};

const copiesAccumulator = (
  sourceCode: SourceCode,
  call: ESTree.CallExpression,
  initialValue: ESTree.Node | undefined,
  isAccumulator: (node: ESTree.Node) => boolean,
): boolean => {
  const method = methodTarget(call.callee);
  const [first] = call.arguments;

  if (method === undefined) {
    return false;
  }

  if (method.name === 'assign' && isGlobalObject(sourceCode, method.object, 'Object')) {
    return assignsIntoFreshValue(call, isAccumulator);
  }

  if (method.name === 'from' && isGlobalObject(sourceCode, method.object, 'Array')) {
    return first !== undefined && isAccumulator(first);
  }

  if (!arrayCopyMethods.has(method.name) || initialValue === undefined) {
    return false;
  }

  return isKnownArrayExpression(sourceCode, initialValue) && isAccumulator(method.object);
};

// Complements oxc/no-accumulating-spread, which catches the spread form of the same copy.
export const noReduceAccumulatorCopyRule: Rule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      accumulatorCopy:
        'Do not copy the reducer accumulator on every iteration; growing copies can cause quadratic work. Mutate a fresh accumulator the reducer owns and return it, or use flatMap.',
    },
  },
  create(context) {
    const { sourceCode } = context;

    return {
      CallExpression(node) {
        const reducer = enclosingReducer(node);

        if (reducer === undefined) {
          return;
        }

        const accumulator = sourceCode
          .getDeclaredVariables(reducer.callback)
          .find((variable) =>
            variable.identifiers.some(
              (identifier) => identifier.start === reducer.accumulator.start,
            ),
          );

        if (accumulator === undefined) {
          return;
        }

        const isAccumulator = (expression: ESTree.Node) =>
          referencesAccumulator(sourceCode, expression, accumulator);

        if (copiesAccumulator(sourceCode, node, reducer.initialValue, isAccumulator)) {
          context.report({ node, messageId: 'accumulatorCopy' });
        }
      },
    };
  },
};
