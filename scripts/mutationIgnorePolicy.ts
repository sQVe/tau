// The parts of a Babel node that the ignorer reads. Stryker passes a Babel NodePath but its types
// declare the path as empty.
interface BabelNode {
  type: string;
  name?: string;
  value?: BabelNode | string | boolean | number | null;
  callee?: BabelNode;
  key?: BabelNode;
  properties?: BabelNode[];
  alternate?: BabelNode;
  expressions?: BabelNode[];
  arguments?: BabelNode[];
}

export interface BabelPath {
  node: BabelNode;
  parent: BabelNode;
  parentPath: { parent: BabelNode } | null;
  key: string | number | null;
  listKey: string | null;
}

// The ignore API skips a node with all its descendants, so a template with an expression keeps
// every mutant.
const isPlainTemplate = (node: BabelNode) =>
  node.type === 'TemplateLiteral' && (node.expressions?.length ?? 0) === 0;

const isTextNode = (node: BabelNode) => node.type === 'StringLiteral' || isPlainTemplate(node);

const messageIndexOfBuiltinError = new Map([
  ['Error', 0],
  ['TypeError', 0],
  ['RangeError', 0],
  ['SyntaxError', 0],
  ['ReferenceError', 0],
  ['EvalError', 0],
  ['URIError', 0],
  ['AggregateError', 1],
]);

// A built-in error has a known message position. Another class ending in `Error` is skipped only
// when it takes a single argument, since a second argument may carry behavior.
const isErrorMessage = ({ parent, listKey, key }: BabelPath) => {
  const className = parent.callee?.type === 'Identifier' ? parent.callee.name : undefined;

  if (parent.type !== 'NewExpression' || listKey !== 'arguments' || className === undefined) {
    return false;
  }

  const builtinIndex = messageIndexOfBuiltinError.get(className);

  if (builtinIndex !== undefined) {
    return key === builtinIndex;
  }

  return className.endsWith('Error') && key === 0 && parent.arguments?.length === 1;
};

const isInvariantCall = (node: BabelNode) =>
  node.type === 'CallExpression' &&
  node.callee?.type === 'Identifier' &&
  node.callee.name === 'invariant';

const isInvariantMessage = ({ parent, listKey, key }: BabelPath) => {
  const isAfterFirstArgument = listKey === 'arguments' && typeof key === 'number' && key > 0;

  return isAfterFirstArgument && isInvariantCall(parent);
};

const propertyName = (property: BabelNode) => {
  if (property.type !== 'ObjectProperty') {
    return undefined;
  }

  const { key } = property;

  return key?.type === 'Identifier' ? key.name : undefined;
};

// Stryker has already wrapped an expression that it mutated, as
// `mutantA ? mutated : mutantB ? mutated : (coverMutant(...), original)`.
const originalOf = (node: BabelNode): BabelNode => {
  if (node.type === 'ConditionalExpression' && node.alternate !== undefined) {
    return originalOf(node.alternate);
  }

  const original = node.type === 'SequenceExpression' ? node.expressions?.at(-1) : undefined;

  return original ?? node;
};

const isFalseLiteral = (node: BabelNode | undefined) =>
  node?.type === 'BooleanLiteral' && node.value === false;

const isOkFalse = (property: BabelNode) => {
  const { value } = property;

  if (propertyName(property) !== 'ok' || typeof value !== 'object' || value === null) {
    return false;
  }

  return isFalseLiteral(originalOf(value));
};

const isFailedResult = (object: BabelNode | undefined) =>
  object?.properties?.some(isOkFalse) === true;

const isFailedResultError = (path: BabelPath) => {
  const { parent } = path;

  if (
    parent.type !== 'ObjectProperty' ||
    path.key !== 'value' ||
    propertyName(parent) !== 'error'
  ) {
    return false;
  }

  return isFailedResult(path.parentPath?.parent);
};

const reasonOf = (path: BabelPath) => {
  if (isErrorMessage(path)) {
    return 'The text of an error message is not behavior.';
  }

  if (isInvariantMessage(path)) {
    return 'The text of an invariant message is not behavior.';
  }

  if (isFailedResultError(path)) {
    return 'The text of an error result is not behavior.';
  }

  return undefined;
};

export const ignorerName = 'tauMessageIgnorer';

export const enabledIgnorers = <Ignorer>(
  names: readonly string[] | undefined,
  ignorer: Ignorer,
): Ignorer[] => (names?.includes(ignorerName) === true ? [ignorer] : []);

export const ignoreReason = (path: BabelPath): string | undefined =>
  isTextNode(path.node) ? reasonOf(path) : undefined;
