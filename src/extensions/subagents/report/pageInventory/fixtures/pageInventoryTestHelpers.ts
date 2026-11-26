import type { PageInventoryElement, PageInventoryPage } from '../pageInventory.js';
import type { PageInventoryRead } from '../pageInventoryDecision.js';

export const inventoryPath = '/agent/assignments/example/page-inventory.md';

export const element = (
  name: string,
  verdict: PageInventoryElement['verdict'],
  expectedState = 'visible',
): PageInventoryElement => ({ element: name, expectedState, verdict });

export const page = (url: string, elements: PageInventoryElement[] = []): PageInventoryPage => ({
  url,
  elements,
});

export const inventory = (pages: PageInventoryPage[]): PageInventoryRead => ({
  status: 'valid',
  pages,
});

export const summaryWithHeading = (heading: string, decisions: string, cite: boolean): string =>
  [
    'Checked the app.',
    '## Changes',
    'None',
    '## Evidence',
    cite ? `page inventory: ${inventoryPath}` : 'None',
    heading,
    decisions,
    '## Concerns',
    'None',
  ].join('\n\n');

export const summaryWith = (decisions: string, cite: boolean): string =>
  summaryWithHeading('## Decisions', decisions, cite);

export const contradictingInbox = inventory([
  page('https://app.test/teams', [element('Your inbox card', 'contradicts')]),
]);

export const unresolvedMessage =
  'Report refused: page-inventory.md marks Your inbox card as contradicts, but the summary\'s Decisions section has no finding whose label before the first ": " is "Your inbox card". Write the finding as "- Your inbox card: <finding>".';
