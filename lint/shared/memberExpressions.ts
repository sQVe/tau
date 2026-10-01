import type { ESTree } from '@oxlint/plugins';

// The property of `object.name` or a constant computed key; a dynamic key has no static name.
export const staticPropertyName = (member: ESTree.MemberExpression): string | undefined => {
  const { property } = member;

  if (!member.computed) {
    return property.type === 'Identifier' ? property.name : undefined;
  }

  if (property.type === 'TemplateLiteral') {
    const cooked = property.quasis[0]?.value.cooked ?? undefined;

    return property.expressions.length === 0 ? cooked : undefined;
  }

  const isString = property.type === 'Literal' && typeof property.value === 'string';

  return isString ? property.value : undefined;
};
