import { ruleTester } from '../fixtures/ruleTester.ts';
import { noHookRegistrationInHookRule } from './noHookRegistrationInHook.ts';

ruleTester.run('no-hook-registration-in-hook', noHookRegistrationInHookRule, {
  valid: [
    'beforeAll(() => { setup(); });\nafterAll(() => { cleanup(); });',
    'beforeEach(() => { setup(); });\nafterEach(() => { cleanup(); });',
  ],
  invalid: [
    {
      code: 'beforeAll(() => { afterAll(() => { cleanup(); }); });',
      errors: [{ messageId: 'nested' }],
    },
    {
      code: "beforeEach(() => { temporaryDirectory(afterAll, 'probe-'); });",
      errors: [{ messageId: 'nested' }],
    },
    {
      code: 'afterEach(() => { afterAll(() => { cleanup(); }); });',
      errors: [{ messageId: 'nested' }],
    },
  ],
});
