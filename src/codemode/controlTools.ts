interface ToolCallFacts {
  toolName: string;
  parentToolCallId?: string;
}

// Tools that report to the parent, ask a person, or start and stop workers. Only the model may call
// them directly; a call from another tool, such as a codemode script, is refused.
const controlToolNames: ReadonlySet<string> = new Set([
  'subagent_report',
  'subagent_question',
  'subagent_progress',
  'ask_user_question',
  'subagent',
  'subagent_follow_up',
  'subagent_reply',
  'subagent_cancel',
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
