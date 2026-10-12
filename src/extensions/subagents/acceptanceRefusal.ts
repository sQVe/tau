import type { Profile } from './types.js';

export const acceptanceRefusal = (
  role: Profile['role'],
  acceptance: readonly string[] | undefined,
): string | undefined => {
  if (role === 'investigation') {
    return undefined;
  }

  if (acceptance === undefined || acceptance.length === 0) {
    return 'An editing worker needs acceptance criteria. Pass acceptance with at least one item.';
  }

  if (acceptance.some((item) => item.trim() === '')) {
    return 'Acceptance criteria must not contain a blank item.';
  }

  return undefined;
};
