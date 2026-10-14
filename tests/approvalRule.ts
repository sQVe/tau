const trackerAnchor = 'tracker/SKILL.md#hard-rules';

const listItemStart = /^\s*(?:[-*]|\d+\.)\s/;

const writeTopic = /\b(?:linear|github|comment|reply|replies|post(?!-)|cancel\w*|`gh |`linear )/i;

export const splitSegments = (markdown: string): string[] => {
  const segments: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length > 0) {
      segments.push(current.join('\n'));
    }

    current = [];
  };

  for (const line of markdown.split('\n')) {
    const blank = line.trim() === '';

    if (blank || listItemStart.test(line)) {
      flush();
    }

    if (!blank) {
      current.push(line);
    }
  }

  flush();

  return segments;
};

const otherPeople =
  /\b(?:another person|someone else|other people|another's|not the user's own|reviewers?|authors?|maintainers?|contributors?|humans?|persons?)\b/i;

const addressedToBot = /\b(?:to|for)\s+(?:an?\s+|the\s+)?(?:github\s+)?bots?\b/i;

const grantingClauses = (segment: string): string[] =>
  segment
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => /without asking/i.test(sentence))
    .flatMap((sentence) => {
      const clauses = sentence.split(/[,;:]\s|\sthen\s/);
      const granting = clauses.filter((clause) => /without asking/i.test(clause));
      const bare = granting.every((clause) => /^\W*without asking\W*$/i.test(clause));

      return bare ? [sentence] : granting;
    });

const clauseProblem = (clause: string): string | undefined => {
  if (/cancel/i.test(clause)) {
    return 'cancelling a ticket always asks first';
  }

  if (otherPeople.test(clause)) {
    return 'writes that reach other people or their work ask first';
  }

  const aboutGitHub = /github|`gh |\breplies?\b/i.test(clause);

  if (aboutGitHub && !addressedToBot.test(clause)) {
    return 'only writes addressed to GitHub bots go without asking';
  }

  return undefined;
};

/** Returns why a segment grants "without asking" for a write the tracker list does not cover. */
export const approvalProblem = (rawSegment: string): string | undefined => {
  const segment = rawSegment.replaceAll(/\s+/g, ' ');

  if (!/without asking/i.test(segment) || !writeTopic.test(segment)) {
    return undefined;
  }

  for (const clause of grantingClauses(segment)) {
    const problem = clauseProblem(clause);

    if (problem !== undefined) {
      return problem;
    }
  }

  if (!segment.includes(trackerAnchor)) {
    return 'it does not link to the tracker list';
  }

  return undefined;
};
