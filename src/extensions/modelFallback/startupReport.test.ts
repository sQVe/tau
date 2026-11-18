import { expect, it } from 'vitest';

import { shouldReportAtStartup } from './startupReport.js';

const facts = (
  argv: readonly string[],
  stdinIsTerminal = true,
  stdoutIsTerminal = true,
): Parameters<typeof shouldReportAtStartup>[0] => ({ argv, stdinIsTerminal, stdoutIsTerminal });

it.each([
  ['no arguments on two terminals', facts([]), false],
  ['a model selection on two terminals', facts(['--model', 'tau/x']), false],
  ['print mode with a prompt', facts(['-p', 'hi']), true],
  ['print mode with a long flag', facts(['--print']), true],
  ['list mode', facts(['--list-models']), true],
  ['list mode with a filter', facts(['--list-models', 'tau']), true],
  ['RPC mode', facts(['--mode', 'rpc']), true],
  ['standard input that is not a terminal', facts([], false), true],
  ['standard output that is not a terminal', facts([], true, false), true],
] as const)('%s decides startup reporting', (_name, input, expected) => {
  expect(shouldReportAtStartup(input)).toBe(expected);
});
