import type { ESTree } from '@oxlint/plugins';

// The property of `object.name` or `object['name']`; a dynamic key has no static name.
export const staticPropertyName = (member: ESTree.MemberExpression): string | undefined => {
  const { property } = member;

  if (!member.computed) {
    return property.type === 'Identifier' ? property.name : undefined;
  }

  const isString = property.type === 'Literal' && typeof property.value === 'string';

  return isString ? property.value : undefined;
};
