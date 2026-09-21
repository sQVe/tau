import type { ESTree, Plugin } from '@oxlint/plugins';

const stylePlugin: Plugin = {
  meta: { name: 'tau' },
  rules: {
    'helper-before-use': {
      meta: {
        type: 'suggestion',
        schema: [],
        messages: { order: 'Define helper "{{name}}" before its callers.' },
      },
      create(context) {
        const checkReferences = (node: ESTree.Node) => {
          for (const variable of context.sourceCode.getDeclaredVariables(node)) {
            for (const reference of variable.references) {
              let name: ESTree.Node = reference.identifier;

              while (name.parent.type === 'TSQualifiedName') {
                name = name.parent;
              }

              if (name.parent.type === 'TSTypeQuery') {
                continue;
              }

              if (reference.isRead() && reference.identifier.range[0] < node.range[0]) {
                context.report({
                  node: reference.identifier,
                  messageId: 'order',
                  data: { name: variable.name },
                });
              }
            }
          }
        };

        return {
          FunctionDeclaration: checkReferences,
          // ponytail: infer only function syntax; factory-returned helpers need type-aware lint.
          VariableDeclarator(node) {
            let initializer = node.init;

            if (!initializer) {
              return;
            }

            while (
              initializer.type === 'TSAsExpression' ||
              initializer.type === 'TSSatisfiesExpression' ||
              initializer.type === 'TSTypeAssertion' ||
              initializer.type === 'TSNonNullExpression' ||
              initializer.type === 'ParenthesizedExpression'
            ) {
              initializer = initializer.expression;
            }

            if (
              node.id.type === 'Identifier' &&
              (initializer.type === 'ArrowFunctionExpression' ||
                initializer.type === 'FunctionExpression')
            ) {
              checkReferences(node);
            }
          },
        };
      },
    },
    'naming-convention': {
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

        return {
          'Program:exit'() {
            const checked = new Set<ESTree.Node>();

            for (const scope of context.sourceCode.scopeManager.scopes) {
              for (const variable of scope.variables) {
                for (const definition of variable.defs) {
                  if (
                    definition.type === 'ImportBinding' ||
                    definition.node.type.startsWith('TS') ||
                    checked.has(definition.name)
                  ) {
                    continue;
                  }

                  checked.add(definition.name);

                  const unusedMarker =
                    definition.name.name.startsWith('_') &&
                    !variable.references.some((reference) => reference.isRead()) &&
                    (definition.type === 'Parameter' ||
                      (definition.node.type === 'VariableDeclarator' &&
                        definition.node.id.type !== 'Identifier'));
                  const name = unusedMarker ? definition.name.name.slice(1) : definition.name.name;

                  if (unusedMarker && !name) {
                    continue;
                  }

                  checkName(
                    definition.name,
                    definition.type === 'ClassName' ? 'PascalCase' : 'camelCase',
                    name,
                  );
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
    },
  },
};

export default stylePlugin;
