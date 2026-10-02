import { ruleTester } from '../fixtures/ruleTester.ts';
import { extensionBoundaryRule } from './extensionBoundary.ts';

const filename = '/repository/src/extensions/probe/probe.ts';
const flatFilename = '/repository/src/extensions/flat.ts';

ruleTester.run('extension-boundary', extensionBoundaryRule, {
  valid: [
    { code: "import { own } from './own.js';\n\nexport const value = own;", filename },
    {
      code: "import { errorMessage } from '../../errors.js';\n\nexport const value = errorMessage;",
      filename,
    },
    {
      code: "import { parseModelEntry } from '../../models/models.js';\n\nexport const value = parseModelEntry;",
      filename,
    },
    {
      code: "import { errorMessage } from '../errors.js';\n\nexport const value = errorMessage;",
      filename: flatFilename,
    },
    {
      code: "import commit from './extensions/commit/commit.js';\nimport coding from './extensions/coding.js';\n\nexport default [commit, coding];",
      filename: '/repository/src/tau.ts',
    },
    {
      code: "import { readOwnedWorker } from './extensions/subagents/controller/record.js';\n\nexport const value = readOwnedWorker;",
      filename: '/repository/src/tau.ts',
    },
    {
      code: "import { readOwnedWorker } from './controller/record.js';\nimport { names } from './names.js';\n\nexport const value = [readOwnedWorker, names];",
      filename: '/repository/src/extensions/subagents/subagents.ts',
    },
    {
      code: "import { effectiveAllowedModels } from '../../models/allowedModels.js';\n\nexport const value = effectiveAllowedModels;",
      filename: '/repository/src/extensions/probe/probe.test.ts',
    },
    {
      code: "import { effectiveAllowedModels } from '../../../models/allowedModels.js';\n\nexport const value = effectiveAllowedModels;",
      filename: '/repository/src/extensions/probe/fixtures/fake.ts',
    },
    {
      code: "import { helper } from '../src/extensions/probe/helper.js';\n\nexport const value = helper;",
      filename: '/repository/tests/probe.ts',
    },
  ],
  invalid: [
    {
      code: "import { bulkReadTool } from '../bulkRead/tool.js';\n\nexport const value = bulkReadTool;",
      filename,
      errors: [
        { messageId: 'private', data: { folder: 'extensions/bulkRead', file: 'tool' } },
        { messageId: 'crossing', data: { source: 'probe', target: 'bulkRead' } },
      ],
    },
    {
      code: "export { bulkReadTool } from '../bulkRead/tool.js';",
      filename,
      errors: [{ messageId: 'private' }, { messageId: 'crossing' }],
    },
    {
      code: "export const load = () => import('../bulkRead/tool.js');",
      filename,
      errors: [{ messageId: 'private' }, { messageId: 'crossing' }],
    },
    {
      code: "import coding from '../coding.js';\n\nexport default coding;",
      filename,
      errors: [{ messageId: 'crossing', data: { source: 'probe', target: 'coding' } }],
    },
    {
      code: "import bulkRead from './bulkRead/bulkRead.js';\n\nexport default bulkRead;",
      filename: flatFilename,
      errors: [{ messageId: 'crossing', data: { source: 'flat', target: 'bulkRead' } }],
    },
    {
      code: "import tau from '../../tau.js';\n\nexport default tau;",
      filename,
      errors: [{ messageId: 'root', data: { source: 'probe' } }],
    },
    {
      code: "import tau from '../tau.js';\n\nexport default tau;",
      filename: flatFilename,
      errors: [{ messageId: 'root', data: { source: 'flat' } }],
    },
    {
      code: "import { effectiveAllowedModels } from '../../models/allowedModels.js';\n\nexport const value = effectiveAllowedModels;",
      filename,
      errors: [{ messageId: 'private', data: { folder: 'models', file: 'allowedModels' } }],
    },
    {
      code: "import { effectiveAllowedModels } from './models/allowedModels.js';\n\nexport const value = effectiveAllowedModels;",
      filename: '/repository/src/tau.ts',
      errors: [{ messageId: 'private', data: { folder: 'models', file: 'allowedModels' } }],
    },
  ],
});
