import type { ESTree, Rule, SourceCode } from '@oxlint/plugins';

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

// `SAFETY:` followed by text, not preceded by a letter, digit, or underscore.
const safetyPattern = /(?:^|[^\p{L}\p{N}_])SAFETY\s*:\s*\S/u;

// Comments above these statements explain the assertions inside them.
const commentOwnerKinds = new Set([
  'ExpressionStatement',
  'PropertyDefinition',
  'ReturnStatement',
  'ThrowStatement',
  'VariableDeclaration',
]);

const isConstAssertion = (node: TypeAssertion): boolean => {
  const annotation = node.typeAnnotation;

  return (
    annotation.type === 'TSTypeReference' &&
    annotation.typeName.type === 'Identifier' &&
    annotation.typeName.name === 'const'
  );
};

const hasSafetyCommentBefore = (
  sourceCode: SourceCode,
  owner: ESTree.Node,
  assertion: TypeAssertion,
): boolean =>
  sourceCode
    .getCommentsBefore(owner)
    .some((comment) => comment.end <= assertion.start && safetyPattern.test(comment.value));

// The loop whose head declares `node`; the comment above that loop covers the declaration.
const loopHeadOf = (node: ESTree.Node): ESTree.Node | undefined => {
  const { parent } = node;

  if (parent?.type === 'ForStatement') {
    return parent.init === node ? parent : undefined;
  }

  const isForInOrOf = parent?.type === 'ForInStatement' || parent?.type === 'ForOfStatement';

  return isForInOrOf && parent.left === node ? parent : undefined;
};

const exportOf = (owner: ESTree.Node): ESTree.Node | undefined => {
  const parent = owner.parent;
  const exportsOwner = parent?.type === 'ExportNamedDeclaration' && parent.declaration === owner;

  return exportsOwner ? parent : undefined;
};

// Search from the assertion outward, stopping at the statement that owns it.
const hasSafetyComment = (sourceCode: SourceCode, assertion: TypeAssertion): boolean => {
  let current: ESTree.Node = assertion;

  while (!hasSafetyCommentBefore(sourceCode, current, assertion)) {
    if (commentOwnerKinds.has(current.type)) {
      const loop = loopHeadOf(current);

      if (loop !== undefined) {
        return hasSafetyCommentBefore(sourceCode, loop, assertion);
      }

      const exported = exportOf(current);

      return exported !== undefined && hasSafetyCommentBefore(sourceCode, exported, assertion);
    }

    if (current.parent.type === 'Program') {
      return false;
    }

    current = current.parent;
  }

  return true;
};

export const requireSafetyCommentForTypeAssertionRule: Rule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      missingSafetyComment:
        'This type assertion has no `SAFETY:` comment. State the checked invariant right before the assertion or its statement.',
    },
  },
  create(context) {
    const checkAssertion = (node: TypeAssertion) => {
      if (!isConstAssertion(node) && !hasSafetyComment(context.sourceCode, node)) {
        context.report({ node, messageId: 'missingSafetyComment' });
      }
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
};
