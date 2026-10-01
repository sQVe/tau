import { ruleTester } from '../fixtures/ruleTester.ts';
import { maxConditionChecksRule } from './maxConditionChecks.ts';

ruleTester.run('max-condition-checks', maxConditionChecksRule, {
  valid: [
    'export const three = (a: boolean, b: boolean, c: boolean) => a || b || c;',
    'export const fallback = (a?: string, b?: string, c?: string, d?: string) => a ?? b ?? c ?? d;',
    'export const negated = (a: boolean, b: boolean, c: boolean) => !(a || b || c);',
    'export const wrapped = (a: boolean, b: boolean, c: boolean) => (a || b || c) satisfies boolean;',
    `export const named = (a: boolean, b: boolean, c: boolean) => {
      const either = b || c;

      return a && either;
    };`,
  ],
  invalid: [
    {
      code: 'export const four = (a: boolean, b: boolean, c: boolean, d: boolean) => a || b || c || d;',
      errors: [{ messageId: 'tooMany' }],
    },
    {
      code: 'export const mixed = (a: boolean, b: boolean, c: boolean) => a && (b || c);',
      errors: [{ messageId: 'mixed' }],
    },
    {
      code: 'export const asserted = (a: boolean, b: boolean, c: boolean) => a && ((b || c) as boolean);',
      errors: [{ messageId: 'mixed' }],
    },
    {
      code: 'export const satisfied = (a: boolean, b: boolean, c: boolean) => a && ((b || c) satisfies boolean);',
      errors: [{ messageId: 'mixed' }],
    },
    {
      code: 'export const negated = (a: boolean, b: boolean, c: boolean) => a && !(b || c);',
      errors: [{ messageId: 'mixed' }],
    },
  ],
});
