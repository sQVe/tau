import type { RoleKind } from '../../role.js';

export interface LeadModelFacts {
  role: RoleKind;
  model: string | undefined;
  configured: string | undefined;
}

// A lead on another model than roles.lead.model warns once at session start. Without a configured
// model there is nothing to compare, and other roles have no lead model.
export const leadModelWarning = (facts: LeadModelFacts): string | undefined => {
  if (facts.role !== 'lead' || facts.configured === undefined) {
    return undefined;
  }

  if (facts.model === facts.configured) {
    return undefined;
  }

  const actual = facts.model ?? 'Pi default';

  return `The lead runs on ${actual}, but roles.lead.model is ${facts.configured}. Start the lead on roles.lead.model to avoid model drift.`;
};
