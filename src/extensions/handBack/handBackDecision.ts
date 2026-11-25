import { Marked } from 'marked';
import type { Tokens } from 'marked';

import type { RoleKind } from '../../role/role.js';

export interface HandBackFacts {
  role: RoleKind;
  finalText: string;
  outcome: 'completed' | 'aborted' | 'error';
  reminded: boolean;
}

export type HandBackDecision =
  | { kind: 'remind' }
  | {
      kind: 'settle';
      reason: 'not-lead' | 'no-text' | 'run-failed' | 'already-reminded' | 'no-hand-back';
    };

interface ChoiceSpan {
  start: number;
  end: number;
}

const actionVerb =
  '(?:run|delete|remove|check|open|set|reply|confirm|do|fix|update|add|create|verify|apply|sign|merge|push|close|install|restart|try)';

const decisionPhrase =
  /\b(?:should|shall|may|can|could|would) i\b|\bdo you want\b|\bwould you (?:like|prefer)\b|\bdo you approve\b|\bis it (?:ok|okay|fine)\b|\bare you (?:ok|okay) with\b|\b(?:which|what)\b/i;

const phraseBreak = /\b(?:who|that|which|whether|because|so|if|when|while|after|before)\b/i;

const determiners = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those']);

const alternativeWordCount = 4;
const previousWordOffset = 2;

const prepositions = new Set([
  'on',
  'in',
  'at',
  'for',
  'to',
  'with',
  'without',
  'from',
  'by',
  'about',
  'if',
  'when',
  'while',
  'after',
  'before',
  'per',
  'via',
]);

const clauseBoundary = /(?:[,;]\s+(?:and|but|so|then)\b|[;]\s|\s-\s|,\s*|(?<=[.!?])\s+)/gi;

const choiceBoundary = /,?\s+(?:and|but|so|then)\b|[;]\s|\s-\s|,\s*/i;
const sentenceBoundary = /(?<=[.!?])\s+/;
const questionPattern = /(?:^|(?<=[.!?])\s+)([^?\n]*\?)/g;

const permissionQuestion =
  /\b(?:should|shall|may|can|could|would) i\b|\bdo you want\b|\bwould you like\b|\bdo you approve\b|\bis it (?:ok|okay|fine)\b|\bare you (?:ok|okay) with\b/i;

const secondPersonQuestion = /\b(?:can|could|would|will) you\b/i;

const userAction = new RegExp(
  [
    String.raw`\byou (?:should|need to|will need to|must)\b[^.!?\n]*\b${actionVerb}\b`,
    String.raw`\b(?:please|kindly)\b[^.!?\n]*\b${actionVerb}\b`,
    String.raw`\b(?:reply|respond) (?:here|with|to this)\b`,
    String.raw`\b${actionVerb}\b[^.!?\n]*\byourself\b`,
    String.raw`^\s*\d+[.)]\s+${actionVerb}\b`,
  ].join('|'),
  'im',
);

const inlineText = (token: Tokens.Generic): string => {
  if (token.type === 'codespan' || token.type === 'html') {
    return '';
  }

  if (token.type === 'br') {
    return '\n';
  }

  if (token.tokens !== undefined) {
    return token.tokens.map(inlineText).join('');
  }

  if (typeof token.text === 'string') {
    return token.text.replaceAll('\n', ' ');
  }

  return token.raw;
};

const hasListItems = (token: Tokens.Generic): boolean =>
  Array.isArray(token.items) &&
  typeof token.ordered === 'boolean' &&
  typeof token.loose === 'boolean';

const isListStart = (start: unknown): start is number | '' =>
  start === '' || typeof start === 'number';

const isList = (token: Tokens.Generic): token is Tokens.List =>
  token.type === 'list' && hasListItems(token) && isListStart(token.start);

const hasTableCells = (token: Tokens.Generic): boolean =>
  Array.isArray(token.align) && Array.isArray(token.header) && Array.isArray(token.rows);

const isTable = (token: Tokens.Generic): token is Tokens.Table =>
  token.type === 'table' && hasTableCells(token);

const tableText = (table: Tokens.Table): string => {
  const cells = [...table.header, ...table.rows.flat()];
  const text = cells.map((cell) => cell.tokens.map(inlineText).join('')).join('\n');

  return `${text}\n`;
};

const blockText = (token: Tokens.Generic): string => {
  if (token.type === 'code' || token.type === 'blockquote') {
    return '\n';
  }

  if (token.type === 'space' || token.type === 'hr') {
    return '\n';
  }

  if (isList(token)) {
    const items = token.items.map((item, index) => {
      const marker = token.ordered ? `${Number(token.start) + index}. ` : '- ';
      const text = item.tokens.map(blockText).join('').trimEnd();

      return `${marker}${text}`;
    });

    return `${items.join('\n')}\n`;
  }

  if (isTable(token)) {
    return tableText(token);
  }

  if (token.tokens !== undefined) {
    return `${token.tokens.map(inlineText).join('')}\n`;
  }

  return `${inlineText(token)}\n`;
};

const markdown = new Marked({ gfm: true, pedantic: false });

const visibleText = (text: string): string => markdown.lexer(text).map(blockText).join('');

const choiceStart = (question: string, phraseIndex: number): number => {
  let start = 0;

  for (const match of question.matchAll(clauseBoundary)) {
    const end = match.index + match[0].length;

    if (end <= phraseIndex) {
      start = end;
    }
  }

  return start;
};

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');

const parallelAlternatives = (
  leftWords: readonly string[],
  rightWords: readonly string[],
): boolean => {
  const firstRight = rightWords[0];

  if (firstRight === undefined) {
    return false;
  }

  if (determiners.has(firstRight)) {
    return leftWords.some((word) => determiners.has(word));
  }

  const leftLast = leftWords.at(-1);
  const leftPrevious = leftWords.at(-previousWordOffset);

  return leftLast !== undefined && !prepositions.has(leftPrevious ?? '');
};

const choiceSpan = (question: string): ChoiceSpan | undefined => {
  const phrase = decisionPhrase.exec(question);

  if (phrase === null) {
    return undefined;
  }

  const afterPhrase = question.slice(phrase.index + phrase[0].length);
  const alternative = /\bor\b/i.exec(afterPhrase);

  if (alternative === null) {
    return undefined;
  }

  const scope = afterPhrase.slice(0, alternative.index);
  const phraseText = phrase[0].toLowerCase();
  const namedForm = phraseText === 'which' || phraseText === 'what';
  const namedSeparator = scope.includes(',') || scope.includes(':');

  if (namedForm && !namedSeparator) {
    return undefined;
  }

  if (phraseBreak.test(scope)) {
    return undefined;
  }

  const orStart = phrase.index + phrase[0].length + alternative.index;
  const orEnd = orStart + alternative[0].length;
  const afterAlternative = question.slice(orEnd);
  const boundary = choiceBoundary.exec(afterAlternative);
  const end = boundary === null ? question.length : orEnd + boundary.index;
  const leftWords = words(question.slice(0, orStart)).slice(-alternativeWordCount);
  const rightWords = words(question.slice(orEnd, end));

  if (!parallelAlternatives(leftWords, rightWords)) {
    return undefined;
  }

  return { start: choiceStart(question, phrase.index), end };
};

const maskChoiceQuestions = (text: string): string =>
  text
    .split('\n')
    .map((line) =>
      line.replace(questionPattern, (question) => {
        const span = choiceSpan(question);

        if (span === undefined) {
          return question;
        }

        const masked = ' '.repeat(span.end - span.start);

        return `${question.slice(0, span.start)}${masked}${question.slice(span.end)}`;
      }),
    )
    .join('\n');

const questionSentences = (text: string): string[] =>
  text.split(sentenceBoundary).filter((sentence) => sentence.trimEnd().endsWith('?'));

const asksPermission = (sentence: string): boolean => permissionQuestion.test(sentence);

const hasHandBack = (text: string): boolean => {
  const visible = maskChoiceQuestions(text);
  const questions = questionSentences(visible);
  const asksUserToAct = questions.some((question) => secondPersonQuestion.test(question));

  return userAction.test(visible) || asksUserToAct || questions.some(asksPermission);
};

export const decideHandBack = (facts: HandBackFacts): HandBackDecision => {
  if (facts.role !== 'lead') {
    return { kind: 'settle', reason: 'not-lead' };
  }

  const text = visibleText(facts.finalText);

  if (text.trim() === '') {
    return { kind: 'settle', reason: 'no-text' };
  }

  if (facts.outcome !== 'completed') {
    return { kind: 'settle', reason: 'run-failed' };
  }

  if (facts.reminded) {
    return { kind: 'settle', reason: 'already-reminded' };
  }

  if (!hasHandBack(text)) {
    return { kind: 'settle', reason: 'no-hand-back' };
  }

  return { kind: 'remind' };
};
