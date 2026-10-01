import type { ESTree } from '@oxlint/plugins';

type VisitorKeys = Readonly<Record<string, readonly string[]>>;

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

const isNode = (value: unknown): value is ESTree.Node =>
  isObject(value) && 'type' in value && typeof value.type === 'string';

// Oxlint nodes store their fields as own data properties, so each visitor key reads one child.
export const childNodes = (node: ESTree.Node, visitorKeys: VisitorKeys): ESTree.Node[] =>
  (visitorKeys[node.type] ?? []).flatMap((key) => {
    const value: unknown = Object.getOwnPropertyDescriptor(node, key)?.value;
    const values: unknown[] = Array.isArray(value) ? value : [value];

    return values.filter(isNode);
  });
