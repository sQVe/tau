interface ToolCallFacts {
  toolName: string;
  parentToolCallId?: string;
}

const controlToolNames: ReadonlySet<string> = new Set([
  'subagent_report',
  'subagent_question',
  'ask_user_question',
  'subagent',
  'subagent_follow_up',
]);

export const nestedControlCallReason =
  'Control tools cannot be called from another tool, such as a codemode script. Call it directly.';

export const isNestedControlCall = (call: ToolCallFacts): boolean =>
  controlToolNames.has(call.toolName) && call.parentToolCallId !== undefined;

// Tools that change files, commits, or test observations. Scripts only gather evidence, so a call
// from another tool is refused.
const changeToolNames: ReadonlySet<string> = new Set(['write', 'edit', 'commit', 'run_tests']);

export const nestedChangeCallReason =
  'write, edit, commit, and run_tests cannot be called from another tool, such as a codemode script. Scripts only gather evidence. Call the tool directly.';

export const isNestedChangeCall = (call: ToolCallFacts): boolean =>
  changeToolNames.has(call.toolName) && call.parentToolCallId !== undefined;
