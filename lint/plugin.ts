import type { Plugin } from '@oxlint/plugins';

import { extensionBoundaryRule } from './rules/extensionBoundary.ts';
import { helperBeforeUseRule } from './rules/helperBeforeUse.ts';
import { maxConditionChecksRule } from './rules/maxConditionChecks.ts';
import { namingConventionRule } from './rules/namingConvention.ts';
import { noEnoentLiteralRule } from './rules/noEnoentLiteral.ts';
import { typePlacementRule } from './rules/typePlacement.ts';

const tauPlugin: Plugin = {
  meta: { name: 'tau' },
  rules: {
    'extension-boundary': extensionBoundaryRule,
    'helper-before-use': helperBeforeUseRule,
    'max-condition-checks': maxConditionChecksRule,
    'naming-convention': namingConventionRule,
    'no-enoent-literal': noEnoentLiteralRule,
    'type-placement': typePlacementRule,
  },
};

export default tauPlugin;
