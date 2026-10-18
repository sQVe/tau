import type { Ignorer } from '@stryker-mutator/api/ignore';
import { declareValuePlugin, PluginKind } from '@stryker-mutator/api/plugin';

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
}

interface BabelPath {
  node: BabelNode;
  parent: BabelNode;
  parentPath: { parent: BabelNode } | null;
  key: string | number | null;
  listKey: string | null;
}

const isTextNode = (node: BabelNode) =>
  node.type === 'StringLiteral' || node.type === 'TemplateLiteral';

const isErrorClass = (callee: BabelNode | undefined) =>
  callee?.type === 'Identifier' && callee.name?.endsWith('Error') === true;

const isErrorMessage = ({ parent, listKey }: BabelPath) =>
  parent.type === 'NewExpression' && listKey === 'arguments' && isErrorClass(parent.callee);

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

export const mutationIgnorer: Ignorer = {
  shouldIgnore(path) {
    // SAFETY: Stryker passes a Babel NodePath; BabelPath lists the fields read here.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the API types the path as empty.
    const babelPath = path as unknown as BabelPath;

    return isTextNode(babelPath.node) ? reasonOf(babelPath) : undefined;
  },
};

export const ignorerName = 'tauMessageIgnorer';

export const strykerPlugins = [declareValuePlugin(PluginKind.Ignore, ignorerName, mutationIgnorer)];
