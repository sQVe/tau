import { Marked } from 'marked';
import { expect, it } from 'vitest';

import { element, page } from './fixtures/pageInventoryTestHelpers.js';
import { collectFindings, needsFinding, readDecisionsSection } from './pageInventoryDecisions.js';

const markdown = new Marked();

const tokensFor = (summary: string) => markdown.lexer(summary);

it('reads a Decisions section from a compact paragraph', () => {
  const tokens = tokensFor(
    [
      'Changes: None',
      'Evidence: page inventory: /agent/page-inventory.md',
      'Decisions:',
      '',
      '- Your inbox card: still visible.',
      '',
      'Concerns: None',
    ].join('\n'),
  );

  const section = readDecisionsSection(tokens, new Set());

  expect(section.kind).toBe('section');
  const findings = section.kind === 'section' ? collectFindings(section.tokens, new Set()) : [];

  expect(findings).toEqual(['Your inbox card: still visible.']);
});

it('stops findings at a section label with notes', () => {
  const tokens = tokensFor(
    [
      '## Decisions',
      '',
      '- Your inbox card: still visible.',
      '- Concerns: no findings.',
      '  - Hidden card: still visible.',
      '',
      '## Concerns',
      'None',
    ].join('\n'),
  );

  const section = readDecisionsSection(tokens, new Set());
  const findings = section.kind === 'section' ? collectFindings(section.tokens, new Set()) : [];

  expect(findings).toEqual(['Your inbox card: still visible.']);
});

it('reads no Decisions section from a fenced Decisions heading', () => {
  const tokens = tokensFor(
    [
      '## Changes',
      'None',
      '',
      '```markdown',
      '## Decisions',
      '- Your inbox card: still visible.',
      '```',
      '',
      '- Team list: still visible.',
      '',
      '## Concerns',
      'None',
    ].join('\n'),
  );

  const section = readDecisionsSection(tokens, new Set());

  const sectionFindings =
    section.kind === 'section' ? collectFindings(section.tokens, new Set()) : [];

  const documentFindings = collectFindings(tokens, new Set());

  expect(sectionFindings).toEqual([]);
  expect(documentFindings).toEqual(['Team list: still visible.']);
});

it('needs a finding only for a contradicting or unsure element', () => {
  const matches = [page('https://app.test/teams', [element('Team list', 'matches')])];
  const contradicts = [page('https://app.test/teams', [element('Team list', 'contradicts')])];

  expect(needsFinding(matches)).toBe(false);
  expect(needsFinding(contradicts)).toBe(true);
});
