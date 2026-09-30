import { ruleTester } from '../fixtures/ruleTester.ts';
import { noModuleMockingRule } from './noModuleMocking.ts';

const mock = { messageId: 'moduleMock' };

ruleTester.run('no-module-mocking', noModuleMockingRule, {
  valid: [
    "import { vi } from 'vitest';\n\nexport const spy = vi.fn();",
    "const vi = { mock: (path: string) => path };\n\nvi.mock('node:fs');",
    "import { vi } from './fakes.js';\n\nvi.mock('node:fs');",
  ],
  invalid: [
    { code: "import { vi } from 'vitest';\n\nvi.mock('node:fs');", errors: [mock] },
    { code: "vi.mock('node:fs');", errors: [mock] },
    { code: "vi['doMock']('node:fs');", errors: [mock] },
    { code: "import { vi as vitest } from 'vitest';\n\nvitest.mock('node:fs');", errors: [mock] },
    {
      code: "import { jest } from '@jest/globals';\n\njest.unstable_mockModule('node:fs');",
      errors: [mock],
    },
  ],
});
