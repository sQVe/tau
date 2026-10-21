import { ruleTester } from '../fixtures/ruleTester.ts';
import { moduleBoundariesRule } from './moduleBoundaries.ts';

const filename = '/repository/src/extensions/probe/probe.ts';
const flatFilename = '/repository/src/extensions/flat.ts';

ruleTester.run('module-boundaries', moduleBoundariesRule, {
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
    {
      code: "import { exec } from './exec.js';\n\nexport const value = exec;",
      filename: '/repository/src/command.ts',
    },
    {
      code: "import { parseModelEntry } from './models.js';\nimport { readConfig } from '../tauConfig.js';\n\nexport const value = [parseModelEntry, readConfig];",
      filename: '/repository/src/models/allowedModels.ts',
    },
    {
      code: "import type { ExecResult } from './exec.js';\n\nexport type Value = ExecResult;",
      filename: '/repository/src/command.ts',
    },
    {
      code: "import { keys } from '../keys.js';\nexport const value = keys;",
      filename: '/repository/src/reviewCapture/fixtures/fakeGit.ts',
    },
    {
      code: "import { anything } from './github.js';\n\nexport const value = anything;",
      filename: '/repository/src/keys.test.ts',
    },
    {
      code: 'export const value = 1;',
      filename: '/repository/src/skills/tdd/helper.ts',
    },
    {
      code: 'export const value = 1;',
      filename: '/repository/src/extensions/snippets/snippets.ts',
    },
    {
      code: 'export const load = (name: string) => import(name);',
      filename: '/repository/tests/probe.ts',
    },
    {
      code: "import { stopOwnedWorker } from './stop.js';\nimport { names } from '../names.js';\n\nexport const value = [stopOwnedWorker, names];",
      filename: '/repository/src/extensions/subagents/controller/controller.ts',
    },
    {
      code: "import { readOwnedWorker } from './controller/record.js';\n\nexport const value = readOwnedWorker;",
      filename: '/repository/src/extensions/subagents/subagents.ts',
    },
    {
      code: "import { snippet } from './asset.js';\n\nexport const value = snippet;",
      filename: '/repository/src/extensions/snippets/snippets/loader.ts',
    },
    {
      code: "import { keys } from '../../../keys.js';\n\nexport const value = keys;",
      filename: '/repository/src/extensions/snippets/fixtures/helper.ts',
    },
  ],
  invalid: [
    {
      code: "import { stopOwnedWorker } from './controller/stop.js';\n\nexport const value = stopOwnedWorker;",
      filename: '/repository/src/extensions/subagents/subagents.ts',
      errors: [
        { messageId: 'private', data: { folder: 'extensions/subagents/controller', file: 'stop' } },
      ],
    },
    {
      code: "import coding from '../coding.js';\n\nexport default coding;",
      filename: '/repository/src/extensions/snippets/snippets.ts',
      errors: [{ messageId: 'crossing', data: { source: 'snippets', target: 'coding' } }],
    },
    {
      code: "import { commitToolGuidelines } from '../commit/tool.js';\n\nexport const value = commitToolGuidelines;",
      filename,
      errors: [
        { messageId: 'private', data: { folder: 'extensions/commit', file: 'tool' } },
        { messageId: 'crossing', data: { source: 'probe', target: 'commit' } },
      ],
    },
    {
      code: "export { commitToolGuidelines } from '../commit/tool.js';",
      filename,
      errors: [{ messageId: 'private' }, { messageId: 'crossing' }],
    },
    {
      code: "export const load = () => import('../commit/tool.js');",
      filename,
      errors: [{ messageId: 'private' }, { messageId: 'crossing' }],
    },
    {
      code: "import coding from '../coding.js';\n\nexport default coding;",
      filename,
      errors: [{ messageId: 'crossing', data: { source: 'probe', target: 'coding' } }],
    },
    {
      code: "import commit from './commit/commit.js';\n\nexport default commit;",
      filename: flatFilename,
      errors: [{ messageId: 'crossing', data: { source: 'flat', target: 'commit' } }],
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
      code: "import tau from './tau.js';\n\nexport default tau;",
      filename: '/repository/src/keys.ts',
      errors: [{ messageId: 'root', data: { source: 'keys' } }],
    },
    {
      code: "import tau from '../tau.js';\n\nexport default tau;",
      filename: '/repository/src/models/models.ts',
      errors: [{ messageId: 'root', data: { source: 'models' } }],
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
    {
      code: 'export const value = 1;',
      filename: '/repository/src/example.ts',
      errors: [{ messageId: 'unknownFile', data: { file: 'example.ts' } }],
    },
    {
      code: 'export const value = 1;',
      filename: '/repository/src/instructions/helper.ts',
      errors: [{ messageId: 'unknownFile', data: { file: 'instructions/helper.ts' } }],
    },
    {
      code: "import { keys } from './keys.js';\n\nexport const value = keys;",
      filename: '/repository/src/command.ts',
      errors: [{ messageId: 'notAllowed', data: { source: 'command', target: 'keys' } }],
    },
    {
      code: "import type { Keys } from './keys.js';\n\nexport type Value = Keys;",
      filename: '/repository/src/command.ts',
      errors: [{ messageId: 'notAllowed', data: { source: 'command', target: 'keys' } }],
    },
    {
      code: "export { keys } from './keys.js';",
      filename: '/repository/src/command.ts',
      errors: [{ messageId: 'notAllowed', data: { source: 'command', target: 'keys' } }],
    },
    {
      code: "export const load = () => import('./keys.js');",
      filename: '/repository/src/command.ts',
      errors: [{ messageId: 'notAllowed' }],
    },
    {
      code: "import { keys } from '../keys.js';\n\nexport const value = keys;",
      filename: '/repository/src/models/models.ts',
      errors: [{ messageId: 'notAllowed', data: { source: 'models', target: 'keys' } }],
    },
    {
      code: "import { commitToolGuidelines } from './extensions/commit/commit.js';\n\nexport const value = commitToolGuidelines;",
      filename: '/repository/src/keys.ts',
      errors: [{ messageId: 'sharedToExtension', data: { source: 'keys', target: 'commit' } }],
    },
    {
      code: 'export const load = (name: string) => import(name);',
      filename: '/repository/src/keys.ts',
      errors: [{ messageId: 'computedImport' }],
    },
    {
      code: 'export const load = (name: string) => import(name);',
      filename: '/repository/src/extensions/probe/probe.ts',
      errors: [{ messageId: 'computedImport' }],
    },
  ],
});
