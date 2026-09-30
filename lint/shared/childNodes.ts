import type { ESTree } from '@oxlint/plugins';

type VisitorKeys = Readonly<Record<string, readonly string[]>>;

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

const isNode = (value: unknown): value is ESTree.Node =>
  isObject(value) && 'type' in value && typeof value.type === 'string';

// Oxlint nodes expose their fields as own enumerable properties, so the entries hold every child.
export const childNodes = (node: ESTree.Node, visitorKeys: VisitorKeys): ESTree.Node[] => {
  const fields = new Map<string, unknown>(Object.entries(node));

  return (visitorKeys[node.type] ?? []).flatMap((key) => {
    const value = fields.get(key);
    const values: unknown[] = Array.isArray(value) ? value : [value];

    return values.filter(isNode);
  });
};
