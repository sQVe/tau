import { ruleTester } from '../fixtures/ruleTester.ts';
import { noReflectGetRule } from './noReflectGet.ts';

ruleTester.run('no-reflect-get', noReflectGetRule, {
  valid: [
    "export const value = Reflect.has({ name: 'a' }, 'name');",
    'const Reflect = { get: () => 1 };\nexport const value = Reflect.get();',
    "export const value = ({ name: 'a' }).name;",
  ],
  invalid: [
    {
      code: "export const value = Reflect.get({ name: 'a' }, 'name');",
      errors: [{ messageId: 'reflectGet' }],
    },
    {
      code: "export const value = Reflect['get']({ name: 'a' }, 'name');",
      errors: [{ messageId: 'reflectGet' }],
    },
  ],
});
