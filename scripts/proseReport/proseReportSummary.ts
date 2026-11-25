import { analyzeProse, checkProse } from '../../src/prose.ts';
import type { ProseRule } from '../../src/prose.ts';

export interface ProseReply {
  source: string;
  line: number;
  model: string;
  text: string;
}

export interface ProseText {
  name: string;
  text: string;
}

interface ProseSample {
  source: string;
  line: number;
  model: string;
  excerpt: string;
}

interface ProseModelCount {
  model: string;
  replies: number;
}

interface ProseRuleSummary {
  rule: ProseRule;
  repliesWithFinding: number;
  findings: number;
  models: ProseModelCount[];
  sample: ProseSample[];
}

interface ProseBandSummary {
  sentences: number;
  sample: ProseSample[];
}

interface ProseRuleCount {
  rule: ProseRule;
  findings: number;
}

interface ProseTextSummary {
  name: string;
  counts: ProseRuleCount[];
}

export interface ProseSummary {
  repliesChecked: number;
  skippedLines: number;
  rules: ProseRuleSummary[];
  band: ProseBandSummary;
  texts: ProseTextSummary[];
}

interface RuleTally {
  repliesWithFinding: number;
  findings: number;
  models: Map<string, number>;
  sample: ProseSample[];
}

const ruleOrder: readonly ProseRule[] = ['longSentence', 'emDash', 'curlyQuote'];
const bandMinimumWords = 25;
const bandMaximumWords = 39;

const emptyTally = (): RuleTally => ({
  repliesWithFinding: 0,
  findings: 0,
  models: new Map(),
  sample: [],
});

const createTallies = (): Record<ProseRule, RuleTally> => ({
  longSentence: emptyTally(),
  emDash: emptyTally(),
  curlyQuote: emptyTally(),
});

const accumulateReply = (
  tallies: Record<ProseRule, RuleTally>,
  band: ProseSample[],
  reply: ProseReply,
): void => {
  const analysis = analyzeProse(reply.text);
  const found = new Set<ProseRule>();

  for (const finding of analysis.findings) {
    const tally = tallies[finding.rule];

    tally.findings += 1;
    found.add(finding.rule);

    tally.sample.push({
      source: reply.source,
      line: reply.line,
      model: reply.model,
      excerpt: finding.excerpt,
    });
  }

  for (const sentence of analysis.sentences) {
    if (sentence.words >= bandMinimumWords && sentence.words <= bandMaximumWords) {
      band.push({
        source: reply.source,
        line: reply.line,
        model: reply.model,
        excerpt: sentence.text,
      });
    }
  }

  for (const rule of found) {
    const tally = tallies[rule];

    tally.repliesWithFinding += 1;
    tally.models.set(reply.model, (tally.models.get(reply.model) ?? 0) + 1);
  }
};

const modelCounts = (models: Map<string, number>): ProseModelCount[] =>
  [...models.entries()]
    .map(([model, replies]) => ({ model, replies }))
    .toSorted(
      (left, right) => right.replies - left.replies || left.model.localeCompare(right.model),
    );

const bySourceThenLine = (
  left: { source: string; line: number },
  right: { source: string; line: number },
): number => left.source.localeCompare(right.source) || left.line - right.line;

const evenlySpaced = <Item>(items: Item[], size: number): Item[] => {
  if (items.length <= size) {
    return items;
  }

  const sampled: Item[] = [];

  for (let index = 0; index < size; index += 1) {
    const item = items[Math.floor((index * items.length) / size)];

    if (item !== undefined) {
      sampled.push(item);
    }
  }

  return sampled;
};

const sampleOf = (items: ProseSample[], size: number): ProseSample[] =>
  evenlySpaced(items.toSorted(bySourceThenLine), size);

const textSummary = (text: ProseText): ProseTextSummary => {
  const findings = checkProse(text.text);

  return {
    name: text.name,
    counts: ruleOrder.map((rule) => ({
      rule,
      findings: findings.filter((finding) => finding.rule === rule).length,
    })),
  };
};

export const summarizeProse = (
  replies: ProseReply[],
  texts: ProseText[],
  sampleSize: number,
  skippedLines: number,
): ProseSummary => {
  const tallies = createTallies();
  const band: ProseSample[] = [];

  for (const reply of replies) {
    accumulateReply(tallies, band, reply);
  }

  return {
    repliesChecked: replies.length,
    skippedLines,
    rules: ruleOrder.map((rule) => ({
      rule,
      repliesWithFinding: tallies[rule].repliesWithFinding,
      findings: tallies[rule].findings,
      models: modelCounts(tallies[rule].models),
      sample: sampleOf(tallies[rule].sample, sampleSize),
    })),
    band: { sentences: band.length, sample: sampleOf(band, sampleSize) },
    texts: texts.map(textSummary),
  };
};

const oneLine = (text: string): string => text.replaceAll(/[\r\n]+/g, ' ');

const inlineCode = (text: string): string => `\`${oneLine(text.replaceAll('`', "'"))}\``;

const table = (headings: string[], rows: string[][]): string[] => {
  const alignment = headings.map((_, index) => (index === 0 ? '---' : '---:'));

  return [
    `| ${headings.join(' | ')} |`,
    `| ${alignment.join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(oneLine).join(' | ')} |`),
  ];
};

const sampleLines = (sample: ProseSample[]): string[] =>
  sample.map(
    (item) =>
      `- ${item.source}:${item.line} model ${inlineCode(item.model)} ${inlineCode(item.excerpt)} Judgment:`,
  );

const modelTable = (summary: ProseSummary): string[] => {
  const rows = summary.rules.flatMap((rule) =>
    rule.models.map((model) => [rule.rule, model.model, String(model.replies)]),
  );

  return rows.length === 0
    ? ['No reply holds a finding.']
    : table(['rule', 'model', 'replies'], rows);
};

const ruleSection = (summary: ProseRuleSummary): string[] => [
  `## ${summary.rule}`,
  '',
  `Sample of ${summary.sample.length} of ${summary.findings} findings, evenly spaced.`,
  '',
  ...sampleLines(summary.sample),
  '',
  'Share judged correct: n/a',
];

const bandSection = (band: ProseBandSummary): string[] => [
  `## ${bandMinimumWords} to ${bandMaximumWords} word sentences`,
  '',
  ...table(
    ['band', 'sentences'],
    [[`${bandMinimumWords} to ${bandMaximumWords} words`, String(band.sentences)]],
  ),
  '',
  `Sample of ${band.sample.length} of ${band.sentences} sentences, evenly spaced.`,
  '',
  ...sampleLines(band.sample),
  '',
  'Share judged correct: n/a',
];

const textSection = (text: ProseTextSummary): string[] => [
  `### ${text.name}`,
  '',
  ...table(
    ['rule', 'findings'],
    text.counts.map((count) => [count.rule, String(count.findings)]),
  ),
];

export const formatProseSummary = (summary: ProseSummary): string => {
  const lines = [
    '# Prose precision report',
    '',
    `Replies checked: ${summary.repliesChecked}`,
    `Text files: ${summary.texts.length}`,
    `Skipped lines: ${summary.skippedLines}`,
    '',
    'Findings by rule',
    '',
    ...table(
      ['rule', 'replies with a finding', 'findings'],
      summary.rules.map((rule) => [
        rule.rule,
        String(rule.repliesWithFinding),
        String(rule.findings),
      ]),
    ),
    '',
    'Replies with a finding, by model',
    '',
    ...modelTable(summary),
    '',
    ...summary.rules.flatMap((rule) => [...ruleSection(rule), '']),
    ...bandSection(summary.band),
    '',
  ];

  if (summary.texts.length > 0) {
    lines.push('## Text files', '', ...summary.texts.flatMap((text) => [...textSection(text), '']));
  }

  return `${lines.join('\n').trimEnd()}\n`;
};
