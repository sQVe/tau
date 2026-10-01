import type { Plugin } from '@oxlint/plugins';

import { extensionBoundaryRule } from './rules/extensionBoundary.ts';
import { helperBeforeUseRule } from './rules/helperBeforeUse.ts';
import { maxConditionChecksRule } from './rules/maxConditionChecks.ts';
import { namingConventionRule } from './rules/namingConvention.ts';
import { noEnoentLiteralRule } from './rules/noEnoentLiteral.ts';
import { noObjectParametersRule } from './rules/noObjectParameters.ts';
import { noReduceAccumulatorCopyRule } from './rules/noReduceAccumulatorCopy.ts';
import { noReflectApplyRule } from './rules/noReflectApply.ts';
import { noReflectGetRule } from './rules/noReflectGet.ts';
import { noUnknownTypeAliasesRule } from './rules/noUnknownTypeAliases.ts';
import { noWidenThenAssertRule } from './rules/noWidenThenAssert.ts';
import { requireSafetyCommentForTypeAssertionRule } from './rules/requireSafetyCommentForTypeAssertion.ts';
import { typePlacementRule } from './rules/typePlacement.ts';

const tauPlugin: Plugin = {
  meta: { name: 'tau' },
  rules: {
    'extension-boundary': extensionBoundaryRule,
    'helper-before-use': helperBeforeUseRule,
    'max-condition-checks': maxConditionChecksRule,
    'naming-convention': namingConventionRule,
    'no-enoent-literal': noEnoentLiteralRule,
    'no-object-parameters': noObjectParametersRule,
    'no-reduce-accumulator-copy': noReduceAccumulatorCopyRule,
    'no-reflect-apply': noReflectApplyRule,
    'no-reflect-get': noReflectGetRule,
    'no-unknown-type-aliases': noUnknownTypeAliasesRule,
    'no-widen-then-assert': noWidenThenAssertRule,
    'require-safety-comment-for-type-assertion': requireSafetyCommentForTypeAssertionRule,
    'type-placement': typePlacementRule,
  },
};

export default tauPlugin;
