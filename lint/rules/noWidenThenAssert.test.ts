import { ruleTester } from '../fixtures/ruleTester.ts';
import { noWidenThenAssertRule } from './noWidenThenAssert.ts';

const widened = (name: string) => ({ messageId: 'widenThenAssert', data: { name } });

ruleTester.run('no-widen-then-assert', noWidenThenAssertRule, {
  valid: [
    'export const read = (input: unknown) => input as string;',
    "const value: unknown = JSON.parse('1');\nexport const count = value as number;",
    "const value: unknown = 'a';\nexport const read = () => value as string;",
    "const value: unknown = 'a';\nexport const same = value as unknown;",
    "const value = { name: 'a' };\nexport const name = value as { name: string };",
  ],
  invalid: [
    {
      code: `interface User { name: string }

export const read = (user: User) => {
  const value: unknown = user;

  return value as User;
};`,
      errors: [widened('value')],
    },
    {
      code: `export const read = () => {
  const value: object = { name: 'a' };

  return value as { name: string };
};`,
      errors: [widened('value')],
    },
    {
      code: "const value: Record<string, unknown> = { name: 'a' };\nexport const names = value as Record<string, string>;",
      errors: [widened('value')],
    },
    {
      code: "const value = { name: 'a' } as unknown;\nexport const named = value as { name: string };",
      errors: [widened('value')],
    },
  ],
});
