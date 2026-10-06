export interface PullRequestFields {
  title: string;
  body: string;
  base: string;
  draft: boolean;
  head: string;
}

type Field = keyof PullRequestFields;

export interface Difference {
  field: Field;
  expected: string | boolean;
  actual: string | boolean;
}

export interface Verification {
  differences: Difference[];
}

const fields: Field[] = ['title', 'body', 'base', 'draft', 'head'];

// GitHub drops the trailing newlines of a body it saves.
const withoutTrailingNewlines = (text: string) => text.replace(/\n+$/u, '');

const comparable = (pullRequest: PullRequestFields, field: Field) => {
  const value = pullRequest[field];

  return field === 'body' ? withoutTrailingNewlines(String(value)) : value;
};

export const comparePullRequest = (
  expected: PullRequestFields,
  actual: PullRequestFields,
): Verification => {
  const differing = fields.filter(
    (field) => comparable(expected, field) !== comparable(actual, field),
  );

  return {
    differences: differing.map((field) => ({
      field,
      expected: expected[field],
      actual: actual[field],
    })),
  };
};
