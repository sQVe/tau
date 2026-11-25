import { expect, it } from 'vitest';

import { formatProseSummary, summarizeProse } from './proseReportSummary.js';
import type { ProseReply, ProseSummary } from './proseReportSummary.js';

const reply = (
  text: string,
  model = 'fixture',
  line = 1,
  source = 'session.jsonl',
): ProseReply => ({
  source,
  line,
  model,
  text,
});

const longSentence = `${Array.from({ length: 41 }, () => 'word').join(' ')}.`;

const sentenceOf = (words: number) => `${Array.from({ length: words }, () => 'word').join(' ')}.`;

const ruleCounts = (summary: ProseSummary) =>
  Object.fromEntries(
    summary.rules.map((rule) => [rule.rule, [rule.repliesWithFinding, rule.findings]]),
  );

const modelCounts = (summary: ProseSummary) =>
  summary.rules.flatMap((rule) =>
    rule.models.map((model) => [rule.rule, model.model, model.replies]),
  );

it('counts replies per rule and model', () => {
  const cases = [
    {
      name: 'no replies',
      replies: [],
      counts: { longSentence: [0, 0], emDash: [0, 0], curlyQuote: [0, 0] },
      models: [],
    },
    {
      name: 'one reply with an em dash',
      replies: [reply('A pause—then more.')],
      counts: { longSentence: [0, 0], emDash: [1, 1], curlyQuote: [0, 0] },
      models: [['emDash', 'fixture', 1]],
    },
    {
      name: 'two replies with long sentences and different models',
      replies: [reply(longSentence, 'beta'), reply(longSentence, 'alpha', 2)],
      counts: { longSentence: [2, 2], emDash: [0, 0], curlyQuote: [0, 0] },
      models: [
        ['longSentence', 'alpha', 1],
        ['longSentence', 'beta', 1],
      ],
    },
    {
      name: 'one reply with two em dashes in one sentence',
      replies: [reply('A pause—then more—and more.')],
      counts: { longSentence: [0, 0], emDash: [1, 1], curlyQuote: [0, 0] },
      models: [['emDash', 'fixture', 1]],
    },
    {
      name: 'one reply with two curly quoted sentences',
      replies: [reply('He said “hi”. She said “bye”.')],
      counts: { longSentence: [0, 0], emDash: [0, 0], curlyQuote: [1, 2] },
      models: [['curlyQuote', 'fixture', 1]],
    },
  ];

  for (const row of cases) {
    const summary = summarizeProse(row.replies, [], 20, 0, 0);

    expect(ruleCounts(summary), row.name).toEqual(row.counts);
    expect(modelCounts(summary), row.name).toEqual(row.models);
  }
});

it('samples evenly', () => {
  const paragraphs = Array.from({ length: 40 }, (_, index) => `Pause—number ${index}.`);
  const summary = summarizeProse([reply(paragraphs.join('\n\n'), 'fixture', 7)], [], 20, 0, 0);

  const sample = summary.rules.find((rule) => rule.rule === 'emDash')?.sample ?? [];

  expect(sample.map((item) => item.excerpt)).toEqual(
    paragraphs.filter((_, index) => index % 2 === 0),
  );

  expect(sample.map((item) => `${item.source}:${item.line}`)).toEqual(
    Array.from({ length: 20 }, () => 'session.jsonl:7'),
  );
});

it('counts the 25 to 39 word band', () => {
  const text = [24, 25, 39, 40].map(sentenceOf).join('\n\n');
  const summary = summarizeProse([reply(text)], [], 20, 0, 0);

  expect(summary.band.sentences).toBe(2);

  expect(summary.band.sample.map((item) => item.excerpt)).toEqual([sentenceOf(25), sentenceOf(39)]);
});

it('gives text files counts without excerpts', () => {
  const text = 'A pause—then more.\n\nHe said “hi”.';

  const output = formatProseSummary(summarizeProse([], [{ name: 'review.md', text }], 20, 0, 0));

  expect(output).toContain('review.md');
  expect(output).toContain('| emDash | 1 |');
  expect(output).toContain('| curlyQuote | 1 |');
  expect(output).not.toContain('A pause');
  expect(output).not.toContain('He said');
});

it('keeps a sample with a newline entity on one line', () => {
  const output = formatProseSummary(summarizeProse([reply('Alpha&#10;beta—gamma.')], [], 20, 0, 0));

  const sample = output.split('\n').find((line) => line.startsWith('- ')) ?? '';

  expect(sample).toContain('Alpha beta—gamma.');
  expect(sample).toContain('Judgment:');
});

it('sorts samples by source and line', () => {
  const summary = summarizeProse(
    [
      reply('A—b.', 'fixture', 1, 'b.jsonl'),
      reply('C—d.', 'fixture', 9, 'a.jsonl'),
      reply('E—f.', 'fixture', 2, 'a.jsonl'),
    ],
    [],
    20,
    0,
    0,
  );

  const sample = summary.rules.find((rule) => rule.rule === 'emDash')?.sample ?? [];

  expect(sample.map((item) => `${item.source}:${item.line}`)).toEqual([
    'a.jsonl:2',
    'a.jsonl:9',
    'b.jsonl:1',
  ]);
});

it('prints skipped files and skipped lines as separate counts', () => {
  const output = formatProseSummary(summarizeProse([], [], 20, 2, 3));

  expect(output).toContain('Skipped files: 2');
  expect(output).toContain('Skipped lines: 3');
});

it('reports a row for every rule in a fixed order', () => {
  const summary = summarizeProse([], [], 20, 0, 0);

  expect(summary.rules.map((row) => row.rule)).toEqual(['longSentence', 'emDash', 'curlyQuote']);
});
