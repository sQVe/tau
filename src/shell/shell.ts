import { afterLeadingWords } from '../wrapperAnalysis.js';

type ShellRedirectionOperator = '<' | '>' | '>>' | '>|' | '<>' | '>&' | '<&' | '&>' | '&>>' | '<<<';

export interface ShellRedirection {
  fileDescriptor: number | undefined;
  operator: ShellRedirectionOperator;
  target: string;
}

type ShellInputKind = 'file' | 'duplicate' | 'heredoc' | 'hereString';

export interface ShellInput {
  // The file descriptor word before the operator, or undefined for standard input.
  descriptor: string | undefined;
  kind: ShellInputKind;
  // The file or descriptor name, or the here-string payload. A heredoc body stays in `heredocs`.
  target: string;
}

interface ShellHeredoc {
  body: string;
  scope: string | undefined;
}

export interface ShellCommand {
  words: string[];
  // The words bash passes to the command: `words` without file descriptor numbers and redirection
  // targets.
  arguments: string[];
  // The redirections that feed the command, in source order.
  inputs: ShellInput[];
  // The heredoc bodies the command owns, in source order. Only an expanding body has a scope.
  heredocs: ShellHeredoc[];
  // The parenthesis nesting depth of the command inside its scope, so a subshell keeps its own
  // directory.
  depth: number;
  // The substitution that runs the command: '' for the top list, and `0`, `0.1`, and so on for
  // each nested `$(...)`, backtick body, or expanding heredoc body.
  scope: string;
  background: boolean;
  // The index of the first command inside this command's group, set only on the command that
  // closes the group.
  group: number | undefined;
  // The shell process that runs the command, as a dotted path from the top-level shell. A command
  // substitution, backtick, expanding heredoc body, pipeline element, or backgrounded unit starts a
  // child shell, so an `exec` there does not change the descriptors of the shell that contains it.
  shellId: string;
  // The index of the next pipeline element whose stdin this command writes to. A command with a
  // pipe on stdout does not write to the terminal, so its stdout target is the pipe.
  pipeTarget: number | undefined;
  redirections: ShellRedirection[];
}

interface PendingHeredoc {
  command: ShellCommand;
  delimiter: string;
  expands: boolean;
  stripsTabs: boolean;
}

interface PipelineElement {
  start: number;
  parentShellId: string | undefined;
}

interface OpenCompound {
  closer: string;
  // The first command index of the unit that encloses the compound.
  unitStart: number;
  // The command index where the compound opens, which is the start of its group.
  start: number;
  // A `case` compound moves from its header to a pattern and then to the pattern's command list.
  caseState: 'header' | 'pattern' | 'command' | undefined;
}

interface ListState {
  command: ShellCommand;
  // The index of `command` in the parser's command list.
  commandIndex: number;
  word: string | undefined;
  wordQuoted: boolean;
  wordCommandStart: number;
  heredocOperator: { stripsTabs: boolean; descriptor: string | undefined } | undefined;
  redirectionTarget: boolean;
  pendingRedirection:
    | {
        fileDescriptor: number | undefined;
        descriptor: string | undefined;
        operator: ShellRedirectionOperator;
      }
    | undefined;
  // The file descriptor word that preceded the pending redirection.
  redirectionDescriptor: string | undefined;
  depth: number;
  // The first command index of the pipeline or list unit at each nesting depth.
  unitStarts: number[];
  // The first command index of the group at each nesting depth.
  groupStarts: number[];
  // The first command index of the pipeline element at each nesting depth, and the shell that
  // contains the pipeline once a pipe starts one.
  elements: PipelineElement[];
  // The open compound keywords, with the first command index of the unit that encloses each.
  compounds: OpenCompound[];
  continuesList: boolean;
  closesSubstitution: boolean;
}

export const quoteShellArgument = (argument: string): string =>
  /^[A-Za-z0-9_./@%+=:,-]+$/u.test(argument)
    ? argument
    : `'${argument.replaceAll("'", String.raw`'\''`)}'`;

const blankCharacters = new Set([' ', '\t']);
const separatorCharacters = new Set([';', '&', '|', '\n', '(', ')']);
const multiCharacterSeparators = new Set(['&&', '||', '|&']);
const caseTerminatorLength = 2;
const caseFallthroughLength = 3;
const listContinuationOperators = new Set(['&&', '||', '|&', '|']);
const longestRedirection = '<<<';
const doubledRedirectionOperators = ['<>', '<&', '>>', '>&', '>|'] as const;

const separatorLength = (character: string, next: string): number =>
  multiCharacterSeparators.has(character + next) ? 2 : 1;

// A compound keyword runs the commands up to its closer as one unit.
const compoundClosers: Readonly<Record<string, string>> = {
  '{': '}',
  case: 'esac',
  for: 'done',
  if: 'fi',
  select: 'done',
  until: 'done',
  while: 'done',
};

const closingKeywords: ReadonlySet<string> = new Set(['}', 'done', 'esac', 'fi']);

// Whether the word at `index` opens or closes a compound. It must sit after only keywords,
// assignments, other compound words, and a reserved `time`, so a compound nested in the same
// command opens at its own word.
const compoundWordAt = (words: readonly string[], index: number): boolean => {
  const word = words[index] ?? '';
  const isCompound = Object.hasOwn(compoundClosers, word) || closingKeywords.has(word);

  const isLeading = (candidate: string): boolean =>
    Object.hasOwn(compoundClosers, candidate) || closingKeywords.has(candidate);

  return isCompound && afterLeadingWords(words, 0, true, isLeading) > index;
};

const closesCasePattern = (compound: OpenCompound | undefined, word: string): boolean =>
  compound?.caseState === 'pattern' && compound.closer === word;

const isBackgroundSeparator = (character: string, length: number): boolean =>
  character === '&' && length === 1;

const continuesListOnNewline = (character: string, continuesList: boolean): boolean =>
  character === '\n' && continuesList;

const continuesListAfter = (operator: string): boolean => listContinuationOperators.has(operator);

const endsListUnit = (character: string, isBackground: boolean): boolean =>
  isBackground || character === ';' || character === '\n';

// A digit word touching `<` or `>` is a file descriptor. Quoting makes it an ordinary word.
const isDigitWord = (word: string): boolean => /^\d+$/u.test(word);

const isIoNumber = (word: string, wordQuoted: boolean, redirectionFollows: boolean) =>
  redirectionFollows && !wordQuoted && isDigitWord(word);

// `n>&m` copies descriptor m onto descriptor n, which can carry an input descriptor onward. The
// bare `>&word` form is output only.
const inputKind = (
  operator: ShellRedirectionOperator,
  descriptor: string | undefined,
  target: string,
): ShellInputKind | undefined => {
  if (operator === '<' || operator === '<>') {
    return 'file';
  }

  if (operator === '<&') {
    return 'duplicate';
  }

  if (operator === '<<<') {
    return 'hereString';
  }

  if (operator === '>&' && descriptor !== undefined && isDigitWord(target)) {
    return 'duplicate';
  }

  return undefined;
};

const rejectPendingHeredoc = (state: ListState) => {
  if (state.heredocOperator !== undefined) {
    throw new Error('Missing heredoc delimiter');
  }
};

const extendedGlobOperators = new Set(['?', '*', '+', '@', '!']);

const ansiCCharacters: Record<string, string> = {
  a: '\u0007',
  b: '\b',
  e: '\u001B',
  E: '\u001B',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

const ansiCEscape =
  /\\(?:(x\{[\dA-Fa-f]*\}?|x[\dA-Fa-f]{1,2}|u[\dA-Fa-f]{1,4}|U[\dA-Fa-f]{1,8}|[0-7]{1,3})|c(\\\\|.)|(.))/gsu;

const octalRadix = 8;
const hexRadix = 16;
const byteMask = 0xff;
const controlMask = 0x1f;
const deleteCode = 0x7f;
const lastCodePoint = 0x10ffff;
const byteDigits = 2;

const decodeAnsiCNumber = (code: string): string => {
  if (/^[0-7]/u.test(code)) {
    return String.fromCodePoint(Number.parseInt(code, octalRadix) & byteMask);
  }

  const digits = code.slice(1).replaceAll(/[{}]/gu, '');

  if (code.startsWith('x')) {
    return String.fromCodePoint(Number.parseInt(`0${digits.slice(-byteDigits)}`, hexRadix));
  }

  const value = Number.parseInt(digits, hexRadix);

  return value > lastCodePoint ? '\uFFFD' : String.fromCodePoint(value);
};

const decodeAnsiCControl = (character: string): string => {
  const code = character === '?' ? deleteCode : character.charCodeAt(0) & controlMask;

  return String.fromCodePoint(code);
};

const decodeAnsiCEscape = (
  escape: string,
  number: string | undefined,
  control: string | undefined,
  other: string | undefined,
): string => {
  if (number !== undefined) {
    return decodeAnsiCNumber(number);
  }

  if (control !== undefined) {
    return decodeAnsiCControl(control);
  }

  return ansiCCharacters[other ?? ''] ?? escape;
};

const decodeAnsiCText = (body: string): string => {
  const decoded = body.replaceAll(ansiCEscape, decodeAnsiCEscape);

  return decoded.split('\u0000', 1)[0] ?? '';
};

// Split shell source into simple commands after quote removal. Commands inside `$(...)`,
// backticks, process substitutions, and expanding heredoc bodies are listed as well, because the
// shell runs them. Parameter expansions stay unexpanded, and substitutions keep their source text.
class ShellParser {
  readonly commands: ShellCommand[] = [];
  private readonly source: string;
  private position = 0;
  private readonly pendingHeredocs: PendingHeredoc[] = [];
  private readonly heredocOwners = new Map<ShellCommand, ShellCommand>();
  private shellId: string;
  private childShells = 0;
  private scope: string;
  private childScopes = 0;

  constructor(source: string, shellId = '0', scope = '') {
    this.source = source;
    this.shellId = shellId;
    this.scope = scope;
  }

  // Each substitution or expanding heredoc body runs in its own scope, named by its parent and an
  // ordinal that is unique within the parse.
  private nextChildScope(): string {
    const ordinal = this.childScopes;

    this.childScopes += 1;

    return this.scope === '' ? String(ordinal) : `${this.scope}.${ordinal}`;
  }

  private childShellIdOf(parentShellId: string): string {
    this.childShells += 1;

    return `${parentShellId}.${this.childShells}`;
  }

  private childShellId(): string {
    return this.childShellIdOf(this.shellId);
  }

  // A substitution runs in a child shell. The parser keeps its position, so only the commands it
  // creates belong to the child.
  private parseSubshell(parse: () => void): void {
    const parentShellId = this.shellId;
    const childShellId = this.childShellId();
    const parentChildShells = this.childShells;
    const parentScope = this.scope;

    this.shellId = childShellId;
    this.childShells = 0;
    this.scope = this.nextChildScope();

    try {
      parse();
    } finally {
      this.shellId = parentShellId;
      this.childShells = parentChildShells;
      this.scope = parentScope;
    }
  }

  // Parse until the end, or until the `)` that closes a `$(` when `closesSubstitution` is set.
  parseList(closesSubstitution: boolean): void {
    const firstCommand = this.commands.length;

    const state: ListState = {
      command: this.startCommand(0),
      commandIndex: this.commands.length - 1,
      word: undefined,
      wordQuoted: false,
      wordCommandStart: 0,
      heredocOperator: undefined,
      redirectionTarget: false,
      pendingRedirection: undefined,
      redirectionDescriptor: undefined,
      depth: 0,
      unitStarts: [firstCommand],
      groupStarts: [],
      elements: [{ start: firstCommand, parentShellId: undefined }],
      compounds: [],
      continuesList: false,
      closesSubstitution,
    };

    while (this.position < this.source.length) {
      const closed = this.readListToken(state);

      if (closed) {
        return;
      }
    }

    if (closesSubstitution) {
      throw new Error('Unterminated command substitution');
    }

    this.finishWord(state);
    rejectPendingHeredoc(state);
    this.readPendingHeredocs();
  }

  // Read text with double-quote rules until `terminator`, or to the end when it is undefined.
  // `dollarQuotes` is false inside double quotes and heredoc bodies, where `$'` and `$"` are plain
  // text.
  readExpandingText(terminator: string | undefined, dollarQuotes: boolean): string {
    let text = '';

    while (this.position < this.source.length) {
      const character = this.source.charAt(this.position);

      if (character === terminator) {
        this.position += 1;

        return text;
      }

      if (character === '\\') {
        text += this.readDoubleQuotedEscape();
      } else if (character === '$') {
        text += this.readExpandingDollar(dollarQuotes);
      } else if (character === '`') {
        text += this.readBacktick();
      } else {
        text += character;
        this.position += 1;
      }
    }

    if (terminator !== undefined) {
      throw new Error(`Unterminated ${terminator}`);
    }

    return text;
  }

  // Returns true when this token starts a redirection.
  private readRedirectionToken(state: ListState, character: string, next: string): boolean {
    if (character === '<' || character === '>') {
      this.finishWord(state, true);
      const redirection = this.readRedirection();

      if (state.pendingRedirection !== undefined) {
        state.redirectionDescriptor = undefined;
      }

      if (redirection.kind === 'heredoc') {
        state.heredocOperator = {
          stripsTabs: redirection.stripsTabs,
          descriptor: state.redirectionDescriptor,
        };

        state.redirectionDescriptor = undefined;
        state.redirectionTarget = false;
        state.pendingRedirection = undefined;
      } else {
        const descriptor = state.redirectionDescriptor;

        state.redirectionTarget = true;

        state.pendingRedirection = {
          fileDescriptor: descriptor === undefined ? undefined : Number(descriptor),
          descriptor,
          operator: redirection.operator,
        };
      }

      return true;
    }

    if (character !== '&' || next !== '>') {
      return false;
    }

    this.finishWord(state);
    const operator = this.source.startsWith('&>>', this.position) ? '&>>' : '&>';

    this.position += operator.length;
    state.redirectionTarget = true;
    state.pendingRedirection = { fileDescriptor: undefined, descriptor: undefined, operator };

    return true;
  }

  // Returns true when this token closes the substitution being parsed.
  private readListToken(state: ListState): boolean {
    const character = this.source.charAt(this.position);
    const next = this.source.charAt(this.position + 1);

    if (character === '#' && state.word === undefined && !this.opensExtendedGlob()) {
      this.skipComment();
    } else if (blankCharacters.has(character)) {
      this.finishWord(state);
      this.position += 1;
    } else if (!this.readRedirectionToken(state, character, next)) {
      if (separatorCharacters.has(character)) {
        return this.readSeparator(state, character);
      }

      this.readWordPiece(state, character);
    }

    return false;
  }

  private opensExtendedGlob(): boolean {
    const opener = this.source.charAt(this.position - 1);
    const operator = this.source.charAt(this.position - 2);

    return opener === '(' && extendedGlobOperators.has(operator);
  }

  private readWordPiece(state: ListState, character: string): void {
    const commandCount = this.commands.length;
    const piece = this.readWordPieceText(character);

    if (piece === undefined) {
      return;
    }

    if (state.word === undefined) {
      state.wordCommandStart = commandCount;
    }

    state.word = (state.word ?? '') + piece.text;
    state.wordQuoted ||= piece.quoted;
    state.continuesList = false;
  }

  // Returns undefined for a line continuation, which adds nothing to the word.
  private readWordPieceText(character: string): { text: string; quoted: boolean } | undefined {
    if (character === '\\') {
      const next = this.source.charAt(this.position + 1);

      this.position += 2;

      return next === '\n' ? undefined : { text: next === '' ? '\\' : next, quoted: true };
    }

    if (character === "'") {
      return { text: this.readSingleQuoted(), quoted: true };
    }

    if (character === '"') {
      this.position += 1;

      return { text: this.readExpandingText('"', false), quoted: true };
    }

    if (character === '$') {
      return this.readDollar(true);
    }

    if (character === '`') {
      return { text: this.readBacktick(), quoted: false };
    }

    this.position += 1;

    return { text: character, quoted: false };
  }

  private readSeparator(state: ListState, character: string): boolean {
    this.finishWord(state);
    rejectPendingHeredoc(state);

    if (continuesListOnNewline(character, state.continuesList)) {
      this.position += 1;
      this.readPendingHeredocs();

      return false;
    }

    const next = this.source.charAt(this.position + 1);

    if (this.readCaseSeparator(state, character, next)) {
      return false;
    }

    const length = separatorLength(character, next);
    const operator = this.source.slice(this.position, this.position + length);
    const isBackground = isBackgroundSeparator(character, length);
    const commandIndex = this.commands.length;

    const endsUnit = this.applySeparatorPipeline(
      state,
      character,
      operator,
      isBackground,
      commandIndex,
    );

    if (character === ')' && state.closesSubstitution && state.depth === 0) {
      this.position += length;

      return true;
    }

    this.restartCommand(state);
    state.continuesList = continuesListAfter(operator);
    this.position += length;

    if (endsUnit) {
      state.unitStarts[state.unitStarts.length - 1] = commandIndex;
    }

    if (character === '\n') {
      this.readPendingHeredocs();
    } else if (character === '(') {
      this.movePipeTarget(commandIndex - 1, commandIndex);
      state.depth += 1;
      state.unitStarts.push(commandIndex);
      state.groupStarts.push(commandIndex);
      state.elements.push({ start: commandIndex, parentShellId: undefined });
    } else if (character === ')') {
      this.closeGroup(state);
    }

    state.command.depth = state.depth;

    return false;
  }

  private restartCommand(state: ListState): void {
    state.command = this.startCommand(state.depth);
    state.commandIndex = this.commands.length - 1;
    state.redirectionTarget = false;
    state.pendingRedirection = undefined;
    state.redirectionDescriptor = undefined;
  }

  private setCaseState(state: ListState, caseState: 'pattern' | 'command'): void {
    const compound = state.compounds.at(-1);

    if (compound?.caseState !== undefined) {
      compound.caseState = caseState;
    }
  }

  // A `case` pattern ends with `)` and a pattern's command list ends with `;;`, `;&`, or `;;&`.
  // None of these closes an enclosing group or ends a pipeline element.
  private readCaseSeparator(state: ListState, character: string, next: string): boolean {
    const caseState = state.compounds.at(-1)?.caseState;

    if (caseState === 'pattern') {
      return this.readCasePatternToken(state, character);
    }

    if (caseState !== 'command') {
      return false;
    }

    const endsPatternList = next === ';' || next === '&';
    const isCaseTerminator = character === ';' && endsPatternList;

    if (!isCaseTerminator) {
      return false;
    }

    this.endCasePatternCommands(state);

    return true;
  }

  private readCasePatternToken(state: ListState, character: string): boolean {
    const isPatternPunctuation = character === '(' || character === '|';

    if (isPatternPunctuation) {
      this.position += 1;

      if (character === '(') {
        this.restartCommand(state);
      }

      return true;
    }

    if (character !== ')') {
      return false;
    }

    this.position += 1;
    this.restartCommand(state);
    state.unitStarts[state.unitStarts.length - 1] = state.commandIndex;
    state.continuesList = false;
    this.setCaseState(state, 'command');

    return true;
  }

  private endCasePatternCommands(state: ListState): void {
    const commandIndex = this.commands.length;

    const terminatorLength = this.source.startsWith(';;&', this.position)
      ? caseFallthroughLength
      : caseTerminatorLength;

    this.endPipeline(state, commandIndex);
    state.unitStarts[state.unitStarts.length - 1] = commandIndex;
    this.restartCommand(state);
    state.continuesList = false;
    this.setCaseState(state, 'pattern');
    this.position += terminatorLength;
  }

  // Returns whether this separator ends the background unit. A pipe starts a new pipeline element,
  // and a list operator or unit end restores the shell that contains the pipeline.
  private applySeparatorPipeline(
    state: ListState,
    character: string,
    operator: string,
    isBackground: boolean,
    commandIndex: number,
  ): boolean {
    // Bash applies `|&` as `2>&1` after the command's own redirections.
    if (operator === '|&') {
      state.command.redirections.push({ fileDescriptor: 2, operator: '>&', target: '1' });
    }

    const endsUnit = endsListUnit(character, isBackground);

    if (endsUnit || operator === '&&' || operator === '||') {
      this.endPipeline(state, commandIndex);
    }

    if (isBackground) {
      this.backgroundUnit(state);
    }

    if (operator === '|' || operator === '|&') {
      this.startPipelineElement(state, commandIndex);
    }

    return endsUnit;
  }

  // A pipeline runs each element in its own subshell, so an `exec` in one element never changes the
  // descriptors of another element or of the shell that contains the pipeline.
  private startPipelineElement(state: ListState, commandIndex: number): void {
    const element = state.elements.at(-1);

    if (element === undefined) {
      return;
    }

    for (const command of this.commands.slice(element.start, commandIndex)) {
      // An inner pipeline already named the element it writes to, so the enclosing pipe must not
      // replace it.
      command.pipeTarget ??= commandIndex;
    }

    if (element.parentShellId === undefined) {
      element.parentShellId = this.shellId;

      const elementShellId = this.childShellIdOf(element.parentShellId);

      for (const command of this.commands.slice(element.start)) {
        this.moveUnderShell(command, elementShellId);
      }
    }

    element.start = commandIndex;
    this.shellId = this.childShellIdOf(element.parentShellId);
  }

  // An element that opens with `(` starts at the group's first command, not at the empty command
  // the separator created, so a pipe must target the group's first command instead.
  private movePipeTarget(from: number, to: number): void {
    for (const command of this.commands) {
      if (command.pipeTarget === from) {
        command.pipeTarget = to;
      }
    }
  }

  private endPipeline(state: ListState, commandIndex: number): void {
    const element = state.elements.at(-1);

    if (element === undefined) {
      return;
    }

    if (element.parentShellId !== undefined) {
      this.shellId = element.parentShellId;
    }

    element.parentShellId = undefined;
    element.start = commandIndex;
  }

  // A command's id starts with the id of the shell that owns it, so replacing that prefix moves the
  // command under a child shell.
  private moveUnderShell(command: ShellCommand, shellId: string): void {
    command.shellId = `${shellId}${command.shellId.slice(this.shellId.length)}`;
  }

  // A trailing `&` backgrounds the whole pipeline or list unit, not only its last command. A
  // compound restores the unit start it opened in when it closes, so the whole compound joins the
  // unit. A command parsed from a heredoc body runs when the command that carries the heredoc
  // expands the body, so it joins the background unit only when that command does. The unit runs in
  // a subshell, so its commands move under one child shell and an `exec` in the unit cannot reach a
  // command outside it.
  private backgroundUnit(state: ListState): void {
    const start = state.unitStarts.at(-1) ?? 0;
    const unit = this.commands.slice(start);
    const backgrounded = new Set(unit);
    const unitShellId = this.childShellId();

    for (const command of unit) {
      const owner = this.heredocOwners.get(command);

      if (owner !== undefined && !backgrounded.has(owner)) {
        continue;
      }

      command.background = true;
      this.moveUnderShell(command, unitShellId);
    }
  }

  // Closing a unit pops its start, leaves the element the unit opened, and restores the shell the
  // element ran in. Both the parenthesis and the compound path must do this in lockstep.
  private closeUnit(state: ListState, groupStart: number): void {
    if (state.unitStarts.length > 1) {
      state.unitStarts.pop();
    }

    const element = state.elements.pop();

    if (element?.parentShellId !== undefined) {
      this.shellId = element.parentShellId;
    }

    state.command.group = groupStart;
  }

  private closeGroup(state: ListState): void {
    state.depth = Math.max(0, state.depth - 1);

    const groupStart = state.groupStarts.pop();

    if (groupStart === undefined) {
      return;
    }

    this.closeUnit(state, groupStart);
  }

  private recordArgument(
    state: ListState,
    word: string,
    wordQuoted: boolean,
    redirectionFollows: boolean,
  ): void {
    const isArgument =
      !isIoNumber(word, wordQuoted, redirectionFollows) && !state.redirectionTarget;

    if (!isArgument) {
      return;
    }

    const wordIndex = state.command.arguments.length;

    state.command.arguments.push(word);

    if (wordQuoted) {
      return;
    }

    this.trackCompound(state, word, wordIndex);
    this.noteCaseWord(state, word);
  }

  private recordRedirectionTarget(state: ListState, word: string): void {
    if (!state.redirectionTarget || state.pendingRedirection === undefined) {
      return;
    }

    const { descriptor, fileDescriptor, operator } = state.pendingRedirection;

    state.command.redirections.push({ fileDescriptor, operator, target: word });

    const kind = inputKind(operator, descriptor, word);

    if (kind !== undefined) {
      state.command.inputs.push({ descriptor, kind, target: word });
    }
  }

  // A case pattern is not a command, so its words never reach the command a guard scans. The
  // closer still runs, because it ends the case instead of naming another pattern.
  private recordWord(
    state: ListState,
    word: string,
    wordQuoted: boolean,
    redirectionFollows: boolean,
  ): void {
    const compound = state.compounds.at(-1);
    const isCasePattern = compound?.caseState === 'pattern';
    const isCaseCloser = !wordQuoted && closesCasePattern(compound, word);

    if (isCasePattern && !isCaseCloser) {
      return;
    }

    state.command.words.push(word);
    this.recordArgument(state, word, wordQuoted, redirectionFollows);
    this.recordRedirectionTarget(state, word);
    state.redirectionTarget = false;
  }

  private finishWord(state: ListState, redirectionFollows = false): void {
    const { word, wordQuoted, heredocOperator } = state;

    if (word === undefined) {
      return;
    }

    if (heredocOperator === undefined) {
      const isDescriptorWord =
        state.pendingRedirection === undefined && isIoNumber(word, wordQuoted, redirectionFollows);

      if (isDescriptorWord) {
        state.command.words.push(word);
        state.redirectionDescriptor = word;
      } else {
        this.recordWord(state, word, wordQuoted, redirectionFollows);
        state.pendingRedirection = undefined;
        state.redirectionDescriptor = undefined;
      }
    } else {
      this.commands.splice(state.wordCommandStart);

      state.command.inputs.push({
        descriptor: heredocOperator.descriptor,
        kind: 'heredoc',
        target: '',
      });

      this.pendingHeredocs.push({
        command: state.command,
        delimiter: word,
        expands: !state.wordQuoted,
        stripsTabs: heredocOperator.stripsTabs,
      });

      state.heredocOperator = undefined;
      state.redirectionDescriptor = undefined;
    }

    state.word = undefined;
    state.wordQuoted = false;
  }

  private applyCompound(state: ListState, word: string, start: number): void {
    const closer = Object.hasOwn(compoundClosers, word) ? compoundClosers[word] : undefined;

    if (closer !== undefined) {
      const unitStart = state.unitStarts.at(-1) ?? start;
      const caseState = word === 'case' ? 'header' : undefined;

      state.compounds.push({ closer, unitStart, start, caseState });
      state.elements.push({ start, parentShellId: undefined });
      // The compound is its own unit, so a separator inside it never reaches the enclosing one.
      state.unitStarts.push(start);

      return;
    }

    if (!closingKeywords.has(word) || state.compounds.at(-1)?.closer !== word) {
      return;
    }

    const compound = state.compounds.pop();

    if (compound === undefined) {
      return;
    }

    this.closeUnit(state, compound.start);
    state.unitStarts[state.unitStarts.length - 1] = compound.unitStart;
  }

  private noteCaseWord(state: ListState, word: string): void {
    const compound = state.compounds.at(-1);

    if (compound?.caseState === 'header' && word === 'in') {
      compound.caseState = 'pattern';
    }
  }

  // A compound keyword runs the commands up to its closer as one unit, so a trailing `&` after the
  // closer backgrounds the whole compound instead of only the closer's command. Opening the
  // compound starts its own unit, so an inner `&` cannot reach the enclosing one. Closing it
  // restores the unit start it opened in, because a separator inside it moved that start forward.
  private trackCompound(state: ListState, word: string, wordIndex: number): void {
    if (!Object.hasOwn(compoundClosers, word) && !closingKeywords.has(word)) {
      return;
    }

    const top = state.compounds.at(-1);
    const closesPatternList = closesCasePattern(top, word);

    if (closesPatternList) {
      this.applyCompound(state, word, state.commandIndex);

      return;
    }

    const leading = compoundWordAt(state.command.arguments, wordIndex);

    if (!leading) {
      return;
    }

    this.applyCompound(state, word, state.commandIndex);
  }

  private readDoubleQuotedEscape(): string {
    const next = this.source.charAt(this.position + 1);

    this.position += 2;

    if (next === '') {
      return '\\';
    }

    if (next === '\n') {
      return '';
    }

    return '$`"\\'.includes(next) ? next : `\\${next}`;
  }

  private startCommand(depth: number): ShellCommand {
    const command: ShellCommand = {
      words: [],
      arguments: [],
      inputs: [],
      heredocs: [],
      depth,
      scope: this.scope,
      background: false,
      group: undefined,
      shellId: this.shellId,
      pipeTarget: undefined,
      redirections: [],
    };

    this.commands.push(command);

    return command;
  }

  private offsetCommand(command: ShellCommand, base: number): void {
    if (command.group !== undefined) {
      command.group += base;
    }

    if (command.pipeTarget !== undefined) {
      command.pipeTarget += base;
    }
  }

  private readSingleQuoted(): string {
    const end = this.source.indexOf("'", this.position + 1);

    if (end === -1) {
      throw new Error("Unterminated '");
    }

    const text = this.source.slice(this.position + 1, end);

    this.position = end + 1;

    return text;
  }

  private readExpandingDollar(dollarQuotes: boolean): string {
    const next = this.source.charAt(this.position + 1);
    const startsQuote = next === "'" || next === '"';

    if (startsQuote && !dollarQuotes) {
      this.position += 1;

      return '$';
    }

    return this.readDollar(dollarQuotes).text;
  }

  private readDollar(dollarQuotes: boolean): { text: string; quoted: boolean } {
    const start = this.position;
    const next = this.source[this.position + 1];

    this.position += 2;

    if (next === '(') {
      this.parseSubshell(() => {
        this.parseList(true);
      });

      return { text: this.source.slice(start, this.position), quoted: false };
    }

    if (next === '{') {
      return { text: `\${${this.readExpandingText('}', dollarQuotes)}}`, quoted: false };
    }

    if (next === "'") {
      return { text: this.readAnsiCBody(), quoted: true };
    }

    if (next === '"') {
      return { text: this.readExpandingText('"', false), quoted: true };
    }

    this.position = start + 1;

    return { text: '$', quoted: false };
  }

  private readAnsiCBody(): string {
    const start = this.position;

    while (this.source[this.position] !== "'") {
      if (this.position >= this.source.length) {
        throw new Error("Unterminated $'");
      }

      this.position += this.source[this.position] === '\\' ? 2 : 1;
    }

    this.position += 1;

    return decodeAnsiCText(this.source.slice(start, this.position - 1));
  }

  private readBacktick(): string {
    let inner = '';

    this.position += 1;

    while (this.source[this.position] !== '`') {
      const character = this.source[this.position];
      const next = this.source[this.position + 1] ?? '';

      if (character === undefined) {
        throw new Error('Unterminated `');
      }

      if (character === '\\' && '$`\\'.includes(next)) {
        inner += next;
        this.position += 2;
      } else {
        inner += character;
        this.position += 1;
      }
    }

    this.position += 1;
    const innerParser = new ShellParser(inner, this.childShellId(), this.nextChildScope());

    innerParser.parseList(false);

    const base = this.commands.length;

    for (const command of innerParser.commands) {
      this.offsetCommand(command, base);
    }

    for (const [command, owner] of innerParser.heredocOwners) {
      this.heredocOwners.set(command, owner);
    }

    this.commands.push(...innerParser.commands);

    return `\`${inner}\``;
  }

  private skipComment(): void {
    const end = this.source.indexOf('\n', this.position);

    this.position = end === -1 ? this.source.length : end;
  }

  // Consume one redirection operator. A heredoc never reaches `redirections`, so its operator stays
  // out of `ShellRedirectionOperator`.
  private readRedirection():
    | { kind: 'heredoc'; stripsTabs: boolean }
    | { kind: 'redirection'; operator: ShellRedirectionOperator } {
    const rest = this.source.slice(this.position, this.position + longestRedirection.length);

    if (rest === longestRedirection) {
      this.position += longestRedirection.length;

      return { kind: 'redirection', operator: longestRedirection };
    }

    if (rest.startsWith('<<')) {
      const stripsTabs = rest === '<<-';

      this.position += stripsTabs ? '<<-'.length : '<<'.length;

      return { kind: 'heredoc', stripsTabs };
    }

    const doubled = doubledRedirectionOperators.find((candidate) => rest.startsWith(candidate));
    const single = rest.startsWith('<') ? '<' : '>';
    const operator: ShellRedirectionOperator = doubled ?? single;

    this.position += operator.length;

    return { kind: 'redirection', operator };
  }

  private readPendingHeredocs(): void {
    for (const heredoc of this.pendingHeredocs.splice(0)) {
      const body = this.readHeredocBody(heredoc);
      const scope = heredoc.expands ? this.nextChildScope() : undefined;

      heredoc.command.heredocs.push({ body, scope });

      if (scope !== undefined) {
        const bodyShellId = this.childShellIdOf(heredoc.command.shellId);
        const bodyParser = new ShellParser(body, bodyShellId, scope);

        bodyParser.readExpandingText(undefined, false);

        const base = this.commands.length;

        for (const command of bodyParser.commands) {
          this.offsetCommand(command, base);
          this.heredocOwners.set(command, heredoc.command);
          command.background ||= heredoc.command.background;
        }

        this.commands.push(...bodyParser.commands);
      }
    }
  }

  private readHeredocBody({ delimiter, stripsTabs }: PendingHeredoc): string {
    let body = '';

    while (this.position < this.source.length) {
      const lineEnd = this.source.indexOf('\n', this.position);
      const end = lineEnd === -1 ? this.source.length : lineEnd;
      const line = this.source.slice(this.position, end);
      const comparedLine = stripsTabs ? line.replace(/^\t+/, '') : line;

      this.position = end + 1;

      if (comparedLine === delimiter) {
        break;
      }

      body += `${line}\n`;
    }

    return body;
  }
}

// Returns undefined when the source is not valid shell syntax as far as this parser can tell.
export const parseShellCommands = (source: string): ShellCommand[] | undefined => {
  const parser = new ShellParser(source);

  try {
    parser.parseList(false);

    return parser.commands;
  } catch {
    return undefined;
  }
};
