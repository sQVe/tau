import { ruleTester } from '../fixtures/ruleTester.ts';
import { helperBeforeUseRule } from './helperBeforeUse.ts';

const order = { messageId: 'order', data: { name: 'helper' } };

ruleTester.run('helper-before-use', helperBeforeUseRule, {
  valid: [
    'export const recursive = (value: number): number => value ? recursive(value - 1) : 0;',
    'export type HelperResult = ReturnType<typeof helper>;\nconst helper = () => 1;',
    'const helper = () => 1;\nexport const caller = () => helper();',
    'export const callback = () => laterValue;\nconst laterValue = 1;',
  ],
  invalid: [
    {
      code: `export const even = (value: number): boolean => value === 0 || odd(value - 1);
const odd = (value: number): boolean => value !== 0 && even(value - 1);`,
      errors: [{ messageId: 'order', data: { name: 'odd' } }],
    },
    { code: 'export const caller = () => helper();\nconst helper = () => 1;', errors: [order] },
    {
      code: `export const caller = () => helper();
const helper = () => 1;
export const other = (helper: () => number) => helper();`,
      errors: [order],
    },
    {
      code: 'export const caller = () => helper();\nconst helper = (() => 1) satisfies () => number;',
      errors: [order],
    },
    {
      code: 'export const caller = () => helper();\nconst helper = function () { return 2; } as () => number;',
      errors: [order],
    },
    {
      code: 'export const caller = () => helper();\nfunction helper() { return 3; }',
      errors: [order],
    },
  ],
});
