import type { ESTree, Rule, SourceCode } from '@oxlint/plugins';

import { createTypeAliasEnvironment, resolvedTypeMatches } from '../shared/typeAliasResolution.ts';
import type { TypeAliasEnvironment } from '../shared/typeAliasResolution.ts';

type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

const isObjectType = (type: ESTree.TSType, matches: (child: ESTree.TSType) => boolean): boolean => {
  if (type.type === 'TSParenthesizedType') {
    return matches(type.typeAnnotation);
  }

  if (type.type === 'TSUnionType') {
    return type.types.some(matches);
  }

  return type.type === 'TSObjectKeyword';
};

// Rest and default parameters may annotate the wrapper or the binding inside it.
const parameterAnnotation = (
  parameter: ESTree.ParamPattern,
): ESTree.TSTypeAnnotation | undefined => {
  if (parameter.type === 'TSParameterProperty') {
    return parameterAnnotation(parameter.parameter);
  }

  if (parameter.type === 'RestElement') {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }

  if (parameter.type === 'AssignmentPattern') {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.left);
  }

  return parameter.typeAnnotation ?? undefined;
};

// The parameter's binding as written, without its annotation or default value.
const parameterName = (parameter: ESTree.ParamPattern, sourceCode: SourceCode): string => {
  if (parameter.type === 'TSParameterProperty') {
    return parameterName(parameter.parameter, sourceCode);
  }

  if (parameter.type === 'AssignmentPattern') {
    return parameterName(parameter.left, sourceCode);
  }

  if (parameter.type === 'RestElement') {
    return parameterName(parameter.argument, sourceCode);
  }

  if (parameter.type === 'Identifier') {
    return parameter.name;
  }

  const text = sourceCode.getText(parameter);
  const annotationStart = parameter.typeAnnotation?.start;

  return annotationStart === undefined
    ? text
    : text.slice(0, annotationStart - parameter.start).trimEnd();
};

export const noObjectParametersRule: Rule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      objectParameter:
        'Parameter `{{parameter}}` uses the broad `object` type. Accept a named type, and parse external input before calling this function.',
    },
  },
  create(context) {
    let environment: TypeAliasEnvironment | undefined;

    const checkParameters = (node: ParameterOwner) => {
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);

        const isObject =
          annotation !== undefined &&
          environment !== undefined &&
          resolvedTypeMatches(annotation.typeAnnotation, environment, isObjectType);

        if (isObject) {
          context.report({
            node: annotation.typeAnnotation,
            messageId: 'objectParameter',
            data: { parameter: parameterName(parameter, context.sourceCode) },
          });
        }
      }
    };

    return {
      Program(program) {
        environment = createTypeAliasEnvironment(program, context.sourceCode.visitorKeys);
      },
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
};
