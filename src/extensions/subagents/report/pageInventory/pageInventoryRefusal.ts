import { decisionsSectionName } from '../reportSections.js';
import { elementSeparator, verdictNames } from './pageInventory.js';
import type { PageInventoryElement } from './pageInventory.js';

export const inventoryFileName = 'page-inventory.md';

export const inventoryMissingMessage = `Report refused: no ${inventoryFileName} in the assignment directory. List each page you opened and every element you saw, then report.`;

export const inventoryUnreadableMessage = (path: string): string =>
  `Report refused: cannot read ${inventoryFileName} at ${path}. Replace it with a readable file, then report.`;

export const inventoryNotRegularMessage = (path: string): string =>
  `Report refused: ${inventoryFileName} at ${path} is not a regular file. Replace it with a regular file, then report.`;

export const inventoryTooLargeMessage = (path: string): string =>
  `Report refused: ${inventoryFileName} at ${path} is too large to read. Replace it with a smaller file, then report.`;

export const inventoryUncitedMessage = `Report refused: the report does not cite the complete path of ${inventoryFileName}. Put its path alone in evidence, or in the summary followed by a space, a line end, or a period, then report.`;

export const inventoryEmptyMessage = `Report refused: ${inventoryFileName} lists no page. Start each page with its URL, then list every element you saw on it.`;

export const malformedElementMessage = (line: number): string =>
  `Report refused: ${inventoryFileName} line ${line} is not "- <element>${elementSeparator}<expected state>${elementSeparator}<verdict>". Rewrite the line with all three parts, then report.`;

const verdictChoices = verdictNames.slice(0, -1).join(', ');
const lastVerdict = verdictNames.at(-1) ?? 'unsure';
const allowedVerdicts = `${verdictChoices}, or ${lastVerdict}`;

export const unknownVerdictMessage = (line: number, verdict: string): string =>
  `Report refused: ${inventoryFileName} line ${line} has verdict "${verdict}". Use ${allowedVerdicts}, then report.`;

export const elementBeforePageMessage = (line: number): string =>
  `Report refused: ${inventoryFileName} line ${line} lists an element before any page URL. Start each page with its URL, then list its elements.`;

export const notPageUrlMessage = (line: number): string =>
  `Report refused: ${inventoryFileName} line ${line} is not a page URL. Start each page with its http or https URL, then list its elements.`;

export const pageWithoutElementMessage = (url: string): string =>
  `Report refused: ${inventoryFileName} lists no element for ${url}. List every element you saw on it, then report.`;

export const unresolvedElementMessage = ({ element, verdict }: PageInventoryElement): string =>
  `Report refused: ${inventoryFileName} marks ${element} as ${verdict}, but the summary's ${decisionsSectionName} section has no finding whose label before the first "${elementSeparator}" is "${element}". Write the finding as "- ${element}${elementSeparator}<finding>".`;

export const nestedDecisionsMessage = `Report refused: the summary's ${decisionsSectionName} heading is inside nested blockquotes. Use one blockquote level, then report.`;
