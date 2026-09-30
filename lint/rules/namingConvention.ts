import type { Definition, ESTree, Rule, Variable } from '@oxlint/plugins';

const isUnusedMarker = (definition: Definition, variable: Variable): boolean => {
  if (!definition.name.name.startsWith('_')) {
    return false;
  }

  if (variable.references.some((reference) => reference.isRead())) {
    return false;
  }

  if (definition.type === 'Parameter') {
    return true;
  }

  return definition.node.type === 'VariableDeclarator' && definition.node.id.type !== 'Identifier';
};

export const namingConventionRule: Rule = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: { name: 'Use {{format}} for "{{name}}".' },
  },
  create(context) {
    const checkName = (
      node: ESTree.BindingIdentifier,
      format: 'camelCase' | 'PascalCase',
      name = node.name,
    ) => {
      const pattern = format === 'camelCase' ? /^[a-z][a-zA-Z0-9]*$/ : /^[A-Z][a-zA-Z0-9]*$/;

      if (!pattern.test(name)) {
        context.report({ node, messageId: 'name', data: { format, name: node.name } });
      }
    };

    const checkDefinition = (
      definition: Definition,
      variable: Variable,
      checked: Set<ESTree.Node>,
    ) => {
      if (
        definition.type === 'ImportBinding' ||
        definition.node.type.startsWith('TS') ||
        checked.has(definition.name)
      ) {
        return;
      }

      checked.add(definition.name);

      const unusedMarker = isUnusedMarker(definition, variable);
      const name = unusedMarker ? definition.name.name.slice(1) : definition.name.name;

      if (unusedMarker && !name) {
        return;
      }

      checkName(
        definition.name,
        definition.type === 'ClassName' ? 'PascalCase' : 'camelCase',
        name,
      );
    };

    return {
      'Program:exit'() {
        const checked = new Set<ESTree.Node>();

        for (const scope of context.sourceCode.scopeManager.scopes) {
          for (const variable of scope.variables) {
            for (const definition of variable.defs) {
              checkDefinition(definition, variable, checked);
            }
          }
        }
      },
      TSInterfaceDeclaration(node) {
        checkName(node.id, 'PascalCase');
      },
      TSTypeAliasDeclaration(node) {
        checkName(node.id, 'PascalCase');
      },
      TSEnumDeclaration(node) {
        checkName(node.id, 'PascalCase');
      },
      TSTypeParameter(node) {
        checkName(node.name, 'PascalCase');
      },
    };
  },
};
