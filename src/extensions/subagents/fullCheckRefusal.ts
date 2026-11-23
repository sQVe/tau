export const fullCheckRefusal = (
  role: 'editing' | 'investigation',
  fullCheck: { owner: string; reason: string } | undefined,
  fullCheckConfigured: boolean,
): string | undefined => {
  if (fullCheck === undefined) {
    return undefined;
  }

  if (fullCheck.owner.trim() === '') {
    return 'fullCheck.owner must not be blank.';
  }

  if (fullCheck.reason.trim() === '') {
    return 'fullCheck.reason must not be blank.';
  }

  if (role === 'investigation') {
    return 'fullCheck applies only to editing workers. An investigation worker does not run the full check.';
  }

  if (!fullCheckConfigured) {
    return 'fullCheck requires a configured full check command. Add fullCheck.argv to .pi/tau.json, then try again.';
  }

  return undefined;
};
