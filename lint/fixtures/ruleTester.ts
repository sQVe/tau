import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';

RuleTester.describe = describe;
RuleTester.it = it;

// Rule tests run in process; tests/lint.test.ts covers loading the plugin through the style command.
export const ruleTester = new RuleTester({
  languageOptions: { sourceType: 'module', parserOptions: { lang: 'ts' } },
});
