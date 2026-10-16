// Decides when to suggest a new session from facts the caller read. tests/structure.test.ts keeps this
// module pure.

export interface ReminderFacts {
  // Percent of the model's context window. Undefined when Pi cannot count the context, such as
  // right after a compaction.
  contextPercent: number | undefined;
  thresholdPercent: number;
  // A reminder was shown since the context last passed the threshold.
  reminded: boolean;
}

export type ReminderStep = 'remind' | 'rearm' | 'keep';

export const decideReminder = (facts: ReminderFacts): ReminderStep => {
  if (facts.contextPercent === undefined) {
    return 'keep';
  }

  const passed = facts.contextPercent > facts.thresholdPercent;

  if (passed) {
    return facts.reminded ? 'keep' : 'remind';
  }

  return facts.reminded ? 'rearm' : 'keep';
};
