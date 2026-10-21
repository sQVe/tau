import type { Plugin } from '@oxlint/plugins';

import { moduleBoundariesRule } from './rules/moduleBoundaries.ts';
import { noEnoentLiteralRule } from './rules/noEnoentLiteral.ts';

const tauPlugin: Plugin = {
  meta: { name: 'tau' },
  rules: {
    'module-boundaries': moduleBoundariesRule,
    'no-enoent-literal': noEnoentLiteralRule,
  },
};

export default tauPlugin;
