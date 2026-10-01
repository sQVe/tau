import type { ESTree } from '@oxlint/plugins';

import { childNodes } from './childNodes.ts';

type VisitorKeys = Readonly<Record<string, readonly string[]>>;

const collectInferredNames = (node: ESTree.Node, visitorKeys: VisitorKeys, names: Set<string>) => {
  if (node.type === 'TSInferType') {
    names.add(node.typeParameter.name.name);
  }

  for (const child of childNodes(node, visitorKeys)) {
    // A nested conditional binds the infer names in its own extends clause.
    const isNestedBinder = node.type === 'TSConditionalType' && child === node.extendsType;

    if (!isNestedBinder) {
      collectInferredNames(child, visitorKeys, names);
    }
  }
};

const isMappedTypeBody = (mapped: ESTree.TSMappedType, descendant: ESTree.Node): boolean =>
  descendant === mapped.nameType || descendant === mapped.typeAnnotation;

// The type names `ancestor` binds for code inside its `descendant` child.
const collectBinders = (
  ancestor: ESTree.Node,
  descendant: ESTree.Node,
  visitorKeys: VisitorKeys,
  names: Set<string>,
) => {
  if ('typeParameters' in ancestor) {
    for (const parameter of ancestor.typeParameters?.params ?? []) {
      names.add(parameter.name.name);
    }
  }

  if (ancestor.type === 'TSMappedType' && isMappedTypeBody(ancestor, descendant)) {
    names.add(ancestor.key.name);
  }

  if (ancestor.type === 'TSConditionalType' && descendant === ancestor.trueType) {
    collectInferredNames(ancestor.extendsType, visitorKeys, names);
  }
};

// Type parameters in scope at `node`; they shadow module type aliases of the same name.
export const lexicalTypeParameterNames = (
  node: ESTree.Node,
  visitorKeys: VisitorKeys,
): ReadonlySet<string> => {
  const names = new Set<string>();
  let descendant = node;
  let current = node;

  // Only Program has no parent, and the walk stops there.
  while (current.type !== 'Program') {
    collectBinders(current, descendant, visitorKeys, names);
    descendant = current;
    current = current.parent;
  }

  return names;
};
