export interface Ownership {
  status: 'own' | 'other' | 'unclear';
  reasons: string[];
}

export type OwnershipFacts =
  | { kind: 'failed'; reason: string }
  | { kind: 'pr'; author: string; viewer: string }
  | { kind: 'commits'; emails: string[]; email: string };

export const decideOwnership = (facts: OwnershipFacts): Ownership => {
  if (facts.kind === 'failed') {
    return { status: 'unclear', reasons: [facts.reason] };
  }

  if (facts.kind === 'pr') {
    const status = facts.author === facts.viewer ? 'own' : 'other';

    return { status, reasons: [] };
  }

  const matches = facts.emails.filter((email) => email === facts.email).length;

  if (matches === facts.emails.length) {
    return { status: 'own', reasons: [] };
  }

  if (matches === 0) {
    return { status: 'other', reasons: [] };
  }

  return {
    status: 'unclear',
    reasons: ['The range has both your commits and commits by other authors.'],
  };
};
