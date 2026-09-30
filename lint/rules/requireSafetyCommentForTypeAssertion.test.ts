import { ruleTester } from '../fixtures/ruleTester.ts';
import { requireSafetyCommentForTypeAssertionRule } from './requireSafetyCommentForTypeAssertion.ts';

const missing = { messageId: 'missingSafetyComment' };

ruleTester.run(
  'require-safety-comment-for-type-assertion',
  requireSafetyCommentForTypeAssertionRule,
  {
    valid: [
      "// SAFETY: The literal is a number.\nexport const value = JSON.parse('1') as number;",
      "export const names = ['a'] as const;",
      'export const read = (input: unknown) => /* SAFETY: Callers pass text. */ input as string;',
      `export const read = (input: unknown) => {
  // SAFETY: Callers pass text.
  return input as string;
};`,
    ],
    invalid: [
      { code: "export const value = JSON.parse('1') as number;", errors: [missing] },
      { code: "// SAFETY:\nexport const value = JSON.parse('1') as number;", errors: [missing] },
      {
        code: "// UNSAFETY: Not a marker.\nexport const value = JSON.parse('1') as number;",
        errors: [missing],
      },
      {
        code: `// SAFETY: The literal is a number.
export const first = JSON.parse('1') as number;
export const second = JSON.parse('2') as number;`,
        errors: [{ ...missing, line: 3 }],
      },
      { code: "export const value = <number>JSON.parse('1');", errors: [missing] },
    ],
  },
);
