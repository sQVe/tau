import type { ESTree } from '@oxlint/plugins';

import { childNodes } from './childNodes.ts';
import { lexicalTypeParameterNames } from './lexicalTypeParameters.ts';

type VisitorKeys = Readonly<Record<string, readonly string[]>>;

type Substitutions = ReadonlyMap<string, Resolution>;

type TypeMatcher = (type: ESTree.TSType, matches: (child: ESTree.TSType) => boolean) => boolean;

// Interfaces, enums, classes, and imports have no alias but still shadow an outer alias.
interface DeclaredType {
  alias: ESTree.TSTypeAliasDeclaration | undefined;
  name: string;
}

interface TypeBinding extends DeclaredType {
  scope: ESTree.Node;
}

interface Resolution {
  type: ESTree.TSType;
  substitutions: Substitutions;
  resolving: ReadonlySet<ESTree.TSTypeAliasDeclaration>;
}

export interface TypeAliasEnvironment {
  bindingsByName: ReadonlyMap<string, readonly TypeBinding[]>;
  visitorKeys: VisitorKeys;
}

const environmentsByProgram = new WeakMap<ESTree.Program, TypeAliasEnvironment>();

const typeScopeKinds = new Set([
  'Program',
  'BlockStatement',
  'TSModuleBlock',
  'StaticBlock',
  'SwitchStatement',
]);

const enclosingTypeScope = (node: ESTree.Node): ESTree.Node => {
  let current = node.parent;

  while (current !== null) {
    if (typeScopeKinds.has(current.type)) {
      return current;
    }

    current = current.parent;
  }

  return node;
};

const declaredName = (node: ESTree.Node): string | undefined => {
  if (node.type === 'TSInterfaceDeclaration' || node.type === 'TSEnumDeclaration') {
    return node.id.name;
  }

  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    return node.id?.name;
  }

  const isImport =
    node.type === 'ImportSpecifier' ||
    node.type === 'ImportDefaultSpecifier' ||
    node.type === 'ImportNamespaceSpecifier';

  return isImport ? node.local.name : undefined;
};

const declaredType = (node: ESTree.Node): DeclaredType | undefined => {
  if (node.type === 'TSTypeAliasDeclaration') {
    return { alias: node, name: node.id.name };
  }

  const name = declaredName(node);

  return name === undefined ? undefined : { alias: undefined, name };
};

const collectTypeBindings = (
  node: ESTree.Node,
  visitorKeys: VisitorKeys,
  bindingsByName: Map<string, TypeBinding[]>,
) => {
  const declared = declaredType(node);

  if (declared !== undefined) {
    const bindings = bindingsByName.get(declared.name) ?? [];
    // A class expression's name is visible only inside the class itself.
    const scope = node.type === 'ClassExpression' ? node : enclosingTypeScope(node);

    bindings.push({ ...declared, scope });
    bindingsByName.set(declared.name, bindings);
  }

  for (const child of childNodes(node, visitorKeys)) {
    collectTypeBindings(child, visitorKeys, bindingsByName);
  }
};

export const createTypeAliasEnvironment = (
  program: ESTree.Program,
  visitorKeys: VisitorKeys,
): TypeAliasEnvironment => {
  const cached = environmentsByProgram.get(program);

  if (cached !== undefined) {
    return cached;
  }

  const bindingsByName = new Map<string, TypeBinding[]>();

  collectTypeBindings(program, visitorKeys, bindingsByName);

  const environment = { bindingsByName, visitorKeys };

  environmentsByProgram.set(program, environment);

  return environment;
};

const ancestorDistance = (ancestor: ESTree.Node, node: ESTree.Node): number | undefined => {
  let current: ESTree.Node | null = node;
  let distance = 0;

  while (current !== null) {
    if (current === ancestor) {
      return distance;
    }

    current = current.parent;
    distance += 1;
  }

  return undefined;
};

const nearestTypeBindings = (
  name: string,
  use: ESTree.Node,
  environment: TypeAliasEnvironment,
): TypeBinding[] => {
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearest: TypeBinding[] = [];

  for (const candidate of environment.bindingsByName.get(name) ?? []) {
    const distance = ancestorDistance(candidate.scope, use);

    if (distance === undefined || distance > nearestDistance) {
      continue;
    }

    if (distance === nearestDistance) {
      nearest.push(candidate);

      continue;
    }

    nearestDistance = distance;
    nearest = [candidate];
  }

  return nearest;
};

// Two bindings in the same scope make the name ambiguous, so neither resolves.
const visibleTypeAlias = (
  name: string,
  use: ESTree.Node,
  environment: TypeAliasEnvironment,
): ESTree.TSTypeAliasDeclaration | undefined => {
  if (lexicalTypeParameterNames(use, environment.visitorKeys).has(name)) {
    return undefined;
  }

  const bindings = nearestTypeBindings(name, use, environment);

  return bindings.length === 1 ? bindings[0]?.alias : undefined;
};

const aliasSubstitutions = (
  alias: ESTree.TSTypeAliasDeclaration,
  reference: ESTree.TSTypeReference,
  caller: Resolution,
  expanding: ReadonlySet<ESTree.TSTypeAliasDeclaration>,
): Substitutions | undefined => {
  const typeArguments = reference.typeArguments?.params ?? [];
  // The alias body sits outside the caller's scope, so it sees only its own parameters.
  const next = new Map<string, Resolution>();

  for (const [index, parameter] of (alias.typeParameters?.params ?? []).entries()) {
    const explicitArgument = typeArguments[index];
    const argument = explicitArgument ?? parameter.default;

    if (argument === null) {
      return undefined;
    }

    // An explicit argument resolves in the caller's context, recursion set included. A default
    // may refer to earlier parameters, so it reads the substitutions built so far.
    const argumentContext =
      explicitArgument === undefined
        ? { substitutions: new Map(next), resolving: expanding }
        : { substitutions: caller.substitutions, resolving: caller.resolving };

    next.set(parameter.name.name, { type: argument, ...argumentContext });
  }

  return next;
};

// The type a reference stands for: a substituted type parameter or a visible alias's body.
const resolveReference = (
  reference: ESTree.TSTypeReference,
  current: Resolution,
  environment: TypeAliasEnvironment,
): Resolution | undefined => {
  if (reference.typeName.type !== 'Identifier') {
    return undefined;
  }

  const name = reference.typeName.name;
  const substitution = current.substitutions.get(name);
  const hasTypeArguments = (reference.typeArguments?.params.length ?? 0) > 0;

  if (substitution !== undefined && !hasTypeArguments) {
    return substitution;
  }

  const alias = visibleTypeAlias(name, reference, environment);

  if (alias === undefined || current.resolving.has(alias)) {
    return undefined;
  }

  const resolving = new Set([...current.resolving, alias]);
  const substitutions = aliasSubstitutions(alias, reference, current, resolving);

  if (substitutions === undefined) {
    return undefined;
  }

  return { type: alias.typeAnnotation, substitutions, resolving };
};

// Match a type after resolving visible aliases and substituting their type parameters.
export const resolvedTypeMatches = (
  type: ESTree.TSType,
  environment: TypeAliasEnvironment,
  matcher: TypeMatcher,
): boolean => {
  const evaluate = (current: Resolution): boolean => {
    const resolved =
      current.type.type === 'TSTypeReference'
        ? resolveReference(current.type, current, environment)
        : undefined;

    if (resolved !== undefined) {
      return evaluate(resolved);
    }

    return matcher(current.type, (child) => evaluate({ ...current, type: child }));
  };

  return evaluate({ type, substitutions: new Map(), resolving: new Set() });
};
