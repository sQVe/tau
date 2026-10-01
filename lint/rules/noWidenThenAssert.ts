import type { ESTree, Rule, SourceCode, Variable } from '@oxlint/plugins';

import { constBinding, resolveVariable } from '../shared/variables.ts';

type BroadTypeKind = 'top' | 'object' | 'record';

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

// What the value is known to be: its asserted or annotated type, or no type for a literal value.
interface KnownValueEvidence {
  type: ESTree.TSType | undefined;
}

interface WidenedBinding {
  broadKind: BroadTypeKind;
  evidence: KnownValueEvidence;
  declaredAt: number;
  boundary: ESTree.Node | undefined;
}

const functionBoundaryKinds = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
  'TSDeclareFunction',
  'TSEmptyBodyFunctionExpression',
]);

const knownValueKinds = new Set([
  'Literal',
  'TemplateLiteral',
  'ArrayExpression',
  'ArrowFunctionExpression',
  'ClassExpression',
  'FunctionExpression',
  'NewExpression',
  'ObjectExpression',
]);

const objectTypeKinds = new Set([
  'TSArrayType',
  'TSConstructorType',
  'TSFunctionType',
  'TSMappedType',
  'TSObjectKeyword',
  'TSTupleType',
]);

const broadKeyKinds = new Set(['TSStringKeyword', 'TSNumberKeyword', 'TSSymbolKeyword']);

// Wrappers that keep the value's type evidence; assertions are handled separately.
const transparentExpressionKinds = new Set([
  'ParenthesizedExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
]);

const isTransparentExpression = (
  expression: ESTree.Expression,
): expression is
  | ESTree.ParenthesizedExpression
  | ESTree.TSNonNullExpression
  | ESTree.TSSatisfiesExpression => transparentExpressionKinds.has(expression.type);

const unwrapExpression = (expression: ESTree.Expression): ESTree.Expression => {
  let current = expression;

  while (isTransparentExpression(current)) {
    current = current.expression;
  }

  return current;
};

const unwrapType = (type: ESTree.TSType): ESTree.TSType => {
  let current = type;

  while (current.type === 'TSParenthesizedType') {
    current = current.typeAnnotation;
  }

  return current;
};

const typeReferenceName = (type: ESTree.TSTypeReference): string | undefined =>
  type.typeName.type === 'Identifier' ? type.typeName.name : undefined;

const isUnknownOrAny = (type: ESTree.TSType): boolean => {
  const unwrapped = unwrapType(type);

  return unwrapped.type === 'TSUnknownKeyword' || unwrapped.type === 'TSAnyKeyword';
};

const isBroadKey = (type: ESTree.TSType): boolean => {
  const unwrapped = unwrapType(type);

  if (broadKeyKinds.has(unwrapped.type)) {
    return true;
  }

  if (unwrapped.type === 'TSUnionType') {
    return unwrapped.types.every(isBroadKey);
  }

  return unwrapped.type === 'TSTypeReference' && typeReferenceName(unwrapped) === 'PropertyKey';
};

// The type inside `Readonly<...>`, or the type itself.
const withoutReadonly = (type: ESTree.TSTypeReference): ESTree.TSType | undefined => {
  if (typeReferenceName(type) !== 'Readonly') {
    return type;
  }

  return type.typeArguments?.params[0];
};

// `Record<string, unknown>` with exactly these two arguments.
const isBroadRecordArguments = (type: ESTree.TSTypeReference): boolean => {
  const [key, value, ...rest] = type.typeArguments?.params ?? [];

  if (typeReferenceName(type) !== 'Record' || rest.length > 0) {
    return false;
  }

  if (key === undefined || value === undefined) {
    return false;
  }

  return isBroadKey(key) && isUnknownOrAny(value);
};

// `{ [key: string]: unknown }` with no other members.
const isBroadIndexSignature = (type: ESTree.TSTypeLiteral): boolean => {
  const [member, ...rest] = type.members;

  if (member?.type !== 'TSIndexSignature' || rest.length > 0) {
    return false;
  }

  const [parameter, ...otherParameters] = member.parameters;

  if (parameter === undefined || otherParameters.length > 0) {
    return false;
  }

  return (
    isBroadKey(parameter.typeAnnotation.typeAnnotation) &&
    isUnknownOrAny(member.typeAnnotation.typeAnnotation)
  );
};

const isBroadRecord = (type: ESTree.TSType): boolean => {
  const unwrapped = unwrapType(type);

  if (unwrapped.type === 'TSTypeLiteral') {
    return isBroadIndexSignature(unwrapped);
  }

  if (unwrapped.type !== 'TSTypeReference') {
    return false;
  }

  const inner = withoutReadonly(unwrapped);

  if (inner !== unwrapped) {
    return inner !== undefined && isBroadRecord(inner);
  }

  return isBroadRecordArguments(unwrapped);
};

const broadTypeKind = (type: ESTree.TSType): BroadTypeKind | undefined => {
  const unwrapped = unwrapType(type);

  if (isUnknownOrAny(unwrapped)) {
    return 'top';
  }

  if (unwrapped.type === 'TSObjectKeyword') {
    return 'object';
  }

  return isBroadRecord(unwrapped) ? 'record' : undefined;
};

const assertedExpression = (node: TypeAssertion): ESTree.Expression =>
  unwrapExpression(node.expression);

const assertionIn = (expression: ESTree.Expression): TypeAssertion | undefined => {
  const unwrapped = unwrapExpression(expression);
  const isAssertion = unwrapped.type === 'TSAsExpression' || unwrapped.type === 'TSTypeAssertion';

  return isAssertion ? unwrapped : undefined;
};

const typeText = (sourceText: string, type: ESTree.TSType): string => {
  const unwrapped = unwrapType(type);

  return sourceText.slice(unwrapped.start, unwrapped.end).replaceAll(/\s+/gu, '');
};

const isDefinitelyObjectType = (type: ESTree.TSType): boolean => {
  const unwrapped = unwrapType(type);

  if (objectTypeKinds.has(unwrapped.type)) {
    return true;
  }

  if (unwrapped.type === 'TSTypeLiteral') {
    return unwrapped.members.length > 0;
  }

  if (unwrapped.type === 'TSIntersectionType') {
    return unwrapped.types.every(isDefinitelyObjectType);
  }

  return (
    unwrapped.type === 'TSTypeOperator' &&
    unwrapped.operator === 'readonly' &&
    isDefinitelyObjectType(unwrapped.typeAnnotation)
  );
};

// `Record<Key, Value>` whose value type is not `unknown` or `any`.
const isNarrowerRecordArguments = (type: ESTree.TSTypeReference): boolean => {
  const [, value, ...rest] = type.typeArguments?.params ?? [];

  if (typeReferenceName(type) !== 'Record' || rest.length > 0) {
    return false;
  }

  return value !== undefined && !isUnknownOrAny(value);
};

const isDefinitelyNarrowerRecord = (type: ESTree.TSType): boolean => {
  const unwrapped = unwrapType(type);

  if (unwrapped.type === 'TSTypeLiteral') {
    return unwrapped.members.some((member) => member.type !== 'TSIndexSignature');
  }

  if (unwrapped.type !== 'TSTypeReference') {
    return false;
  }

  const inner = withoutReadonly(unwrapped);

  if (inner !== unwrapped) {
    return inner !== undefined && isDefinitelyNarrowerRecord(inner);
  }

  return isNarrowerRecordArguments(unwrapped);
};

const functionBoundary = (node: ESTree.Node): ESTree.Node | undefined => {
  let current = node.parent;

  while (current !== null && current.type !== 'Program') {
    if (functionBoundaryKinds.has(current.type)) {
      return current;
    }

    current = current.parent;
  }

  return undefined;
};

// Evidence counts only inside the function that declares the widened binding.
const variableEvidence = (
  variable: Variable,
  boundary: ESTree.Node | undefined,
  initializerEvidence: (initializer: ESTree.Expression) => KnownValueEvidence | undefined,
): KnownValueEvidence | undefined => {
  const annotated = variable.identifiers.find((identifier) => identifier.typeAnnotation != null);
  const annotation = annotated?.typeAnnotation?.typeAnnotation;

  if (annotated !== undefined && annotation !== undefined) {
    const sameFunction = functionBoundary(annotated) === boundary;

    return sameFunction && broadTypeKind(annotation) === undefined
      ? { type: annotation }
      : undefined;
  }

  const binding = constBinding(variable);

  if (binding === undefined || functionBoundary(binding.declarator) !== boundary) {
    return undefined;
  }

  return initializerEvidence(binding.initializer);
};

const knownValueEvidence = (
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  boundary: ESTree.Node | undefined,
  visited: ReadonlySet<Variable>,
): KnownValueEvidence | undefined => {
  const unwrapped = unwrapExpression(expression);
  const assertion = assertionIn(unwrapped);

  if (assertion !== undefined) {
    const isBroad = broadTypeKind(assertion.typeAnnotation) !== undefined;

    return isBroad ? undefined : { type: assertion.typeAnnotation };
  }

  if (knownValueKinds.has(unwrapped.type)) {
    return { type: undefined };
  }

  if (unwrapped.type !== 'Identifier') {
    return undefined;
  }

  const variable = resolveVariable(sourceCode, unwrapped);

  if (variable === undefined || visited.has(variable)) {
    return undefined;
  }

  return variableEvidence(variable, boundary, (initializer) =>
    knownValueEvidence(sourceCode, initializer, boundary, new Set([...visited, variable])),
  );
};

// A const whose annotation or initializer assertion is broad, while its value was known.
const widenedBinding = (sourceCode: SourceCode, variable: Variable): WidenedBinding | undefined => {
  const binding = constBinding(variable);

  if (binding === undefined) {
    return undefined;
  }

  const { declarator, initializer } = binding;
  const declaredType = declarator.id.typeAnnotation?.typeAnnotation;
  const initializerAssertion = assertionIn(initializer);
  const declaredKind = declaredType === undefined ? undefined : broadTypeKind(declaredType);

  const initializerKind =
    initializerAssertion === undefined
      ? undefined
      : broadTypeKind(initializerAssertion.typeAnnotation);

  const broadKind = declaredKind ?? initializerKind;

  if (broadKind === undefined) {
    return undefined;
  }

  const original =
    initializerAssertion !== undefined && initializerKind !== undefined
      ? assertedExpression(initializerAssertion)
      : initializer;

  const boundary = functionBoundary(declarator);
  const evidence = knownValueEvidence(sourceCode, original, boundary, new Set([variable]));

  return evidence === undefined
    ? undefined
    : { broadKind, evidence, declaredAt: declarator.end, boundary };
};

const isNarrowerThanWidened = (
  sourceText: string,
  widened: WidenedBinding,
  assertedType: ESTree.TSType,
): boolean => {
  const { broadKind, evidence } = widened;

  if (broadTypeKind(assertedType) !== undefined) {
    return false;
  }

  const restoresEvidence =
    evidence.type !== undefined &&
    typeText(sourceText, evidence.type) === typeText(sourceText, assertedType);

  if (broadKind === 'top' || restoresEvidence) {
    return true;
  }

  return broadKind === 'object'
    ? isDefinitelyObjectType(assertedType)
    : isDefinitelyNarrowerRecord(assertedType);
};

export const noWidenThenAssertRule: Rule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      widenThenAssert:
        'Binding "{{name}}" discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use.',
    },
  },
  create(context) {
    const { sourceCode } = context;

    const checkAssertion = (node: TypeAssertion) => {
      const expression = assertedExpression(node);

      if (expression.type !== 'Identifier') {
        return;
      }

      const variable = resolveVariable(sourceCode, expression);
      const widened = variable === undefined ? undefined : widenedBinding(sourceCode, variable);

      if (widened === undefined || node.start <= widened.declaredAt) {
        return;
      }

      const sameFunction = functionBoundary(node) === widened.boundary;

      if (sameFunction && isNarrowerThanWidened(sourceCode.text, widened, node.typeAnnotation)) {
        context.report({ node, messageId: 'widenThenAssert', data: { name: expression.name } });
      }
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
};
