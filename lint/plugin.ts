import type { Plugin } from '@oxlint/plugins';

import { extensionBoundaryRule } from './rules/extensionBoundary.ts';
import { noEnoentLiteralRule } from './rules/noEnoentLiteral.ts';

const tauPlugin: Plugin = {
  meta: { name: 'tau' },
  rules: {
    'extension-boundary': extensionBoundaryRule,
    'no-enoent-literal': noEnoentLiteralRule,
  },
};

export default tauPlugin;
