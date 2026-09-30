import { ruleTester } from '../fixtures/ruleTester.ts';
import { noReflectApplyRule } from './noReflectApply.ts';

ruleTester.run('no-reflect-apply', noReflectApplyRule, {
  valid: [
    'export const value = Math.max.apply(undefined, [1, 2]);',
    'const Reflect = { apply: () => 1 };\nexport const value = Reflect.apply();',
    'export const value = Math.max(1, 2);',
  ],
  invalid: [
    {
      code: 'export const value = Reflect.apply(Math.max, undefined, [1, 2]);',
      errors: [{ messageId: 'reflectApply' }],
    },
    {
      code: "export const value = Reflect['apply'](Math.max, undefined, [1, 2]);",
      errors: [{ messageId: 'reflectApply' }],
    },
  ],
});
