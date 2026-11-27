import {
  blockReason,
  unverifiableReason,
} from '../src/extensions/bashGuard/detachedOutputDecision.js';
import { isRecord, text } from '../src/schema.js';
import { quoteShellArgument } from '../src/shell/shell.js';

export const nohupClose =
  'nohup sh -c \'sleep 30; herdr-app do space.close --id sp527dd22aa065042833adf82c857c6cab --confirmed\' >/dev/null 2>&1 & echo "close scheduled"';

export const loggedClose =
  "setsid sh -c 'sleep 25; herdr-app do space.close --id sp527dd22aa065042833adf82c857c6cab --confirmed true > /tmp/tau-space-close.log 2>&1' </dev/null >/dev/null 2>&1 &";

// A chain of nested `bash -c` scripts, which the guard stops inspecting past its depth budget.
export const nestedScript = (depth: number): string =>
  depth === 0 ? 'true' : `bash -c ${quoteShellArgument(nestedScript(depth - 1))}`;

export const blockedOutputReason = (value: unknown): string | undefined => {
  if (!isRecord(value) || value['block'] !== true) {
    return undefined;
  }

  const reason = text(value['reason']);
  const isGuardReason = reason === blockReason || reason === unverifiableReason;

  return isGuardReason ? reason : undefined;
};
