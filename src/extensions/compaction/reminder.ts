// Decides when to suggest /compact from facts the caller read. tests/structure.test.ts keeps this
// module pure.

export interface ReminderFacts {
  // Undefined when Pi cannot count the context, such as right after a compaction.
  contextTokens: number | undefined;
  thresholdTokens: number;
  // A reminder was shown since the context last passed the threshold.
  reminded: boolean;
}

export type ReminderStep = 'remind' | 'rearm' | 'keep';

export const decideReminder = (facts: ReminderFacts): ReminderStep => {
  if (facts.contextTokens === undefined) {
    return 'keep';
  }

  const passed = facts.contextTokens > facts.thresholdTokens;

  if (passed) {
    return facts.reminded ? 'keep' : 'remind';
  }

  return facts.reminded ? 'rearm' : 'keep';
};
