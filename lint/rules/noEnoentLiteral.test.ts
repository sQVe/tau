import { ruleTester } from '../fixtures/ruleTester.ts';
import { noEnoentLiteralRule } from './noEnoentLiteral.ts';

const comparison = "export const missing = (error: { code?: string }) => error.code === 'ENOENT';";

ruleTester.run('no-enoent-literal', noEnoentLiteralRule, {
  valid: [
    "export const reasons = { ENOENT: 'missing' };",
    {
      code: "export const missing = Object.assign(new Error('gone'), { code: 'ENOENT' });",
      filename: '/repository/src/fake.test.ts',
    },
    { code: comparison, filename: '/repository/src/errors/index.ts' },
  ],
  invalid: [
    {
      code: comparison,
      filename: '/repository/src/invalid.ts',
      errors: [{ messageId: 'literal' }],
    },
  ],
});
