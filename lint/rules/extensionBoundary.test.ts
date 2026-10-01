import { ruleTester } from '../fixtures/ruleTester.ts';
import { extensionBoundaryRule } from './extensionBoundary.ts';

const filename = '/repository/src/extensions/probe/probe.ts';

ruleTester.run('extension-boundary', extensionBoundaryRule, {
  valid: [
    { code: "import { own } from './own.js';\n\nexport const value = own;", filename },
    {
      code: "import { errorMessage } from '../../errors/index.js';\n\nexport const value = errorMessage;",
      filename,
    },
    {
      code: "import tau from './extensions/index.js';\n\nexport default tau;",
      filename: '/repository/src/index.ts',
    },
  ],
  invalid: [
    {
      code: "import { bulkReadTool } from '../bulkRead/tool.js';\n\nexport const value = bulkReadTool;",
      filename,
      errors: [{ messageId: 'crossing', data: { source: 'probe', target: 'bulkRead' } }],
    },
    {
      code: "export { bulkReadTool } from '../bulkRead/tool.js';",
      filename,
      errors: [{ messageId: 'crossing' }],
    },
    {
      code: "export const load = () => import('../bulkRead/tool.js');",
      filename,
      errors: [{ messageId: 'crossing' }],
    },
    {
      code: "import tau from '../index.js';\n\nexport default tau;",
      filename,
      errors: [{ messageId: 'root', data: { source: 'probe' } }],
    },
  ],
});
