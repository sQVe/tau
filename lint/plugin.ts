import type { Plugin } from '@oxlint/plugins';

import { moduleBoundariesRule } from './rules/moduleBoundaries.ts';
import { noEnoentLiteralRule } from './rules/noEnoentLiteral.ts';
import { noHookRegistrationInHookRule } from './rules/noHookRegistrationInHook.ts';

const tauPlugin: Plugin = {
  meta: { name: 'tau' },
  rules: {
    'module-boundaries': moduleBoundariesRule,
    'no-enoent-literal': noEnoentLiteralRule,
    'no-hook-registration-in-hook': noHookRegistrationInHookRule,
  },
};

export default tauPlugin;
