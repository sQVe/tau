import { quoteShellArgument } from '../../shell.js';

export interface CheckoutFacts {
  exitCode: number | null;
  stdout: string;
  checkout: string;
}

export const checkoutWarningMessage = (facts: CheckoutFacts): string | undefined => {
  if (facts.exitCode !== 0) {
    return undefined;
  }

  const commitsBehind = Number(facts.stdout.trim());

  if (!Number.isSafeInteger(commitsBehind) || commitsBehind <= 0) {
    return undefined;
  }

  const commits = commitsBehind === 1 ? 'commit' : 'commits';
  const checkout = quoteShellArgument(facts.checkout);

  return `Tau is ${commitsBehind} ${commits} behind its upstream. Update with: git -C ${checkout} pull --ff-only && pnpm -C ${checkout} install`;
};
