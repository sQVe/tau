interface ShellRedirection {
  fileDescriptor: number | undefined;
  operator: string;
  target: string | undefined;
}

export interface ShellCommand {
  words: string[];
  // The words bash passes to the command: `words` without file descriptor numbers and redirection
  // targets.
  arguments: string[];
  heredocs: string[];
  background: boolean;
  redirections: ShellRedirection[];
}

interface PendingHeredoc {
  command: ShellCommand;
  delimiter: string;
  expands: boolean;
  stripsTabs: boolean;
}

interface ListState {
  command: ShellCommand;
  word: string | undefined;
  wordQuoted: boolean;
  wordCommandStart: number;
  heredocOperator: { stripsTabs: boolean } | undefined;
  redirectionTarget: boolean;
  pendingRedirection: { fileDescriptor: number | undefined; operator: string } | undefined;
  depth: number;
  // The first command index of the pipeline or list unit at each nesting depth.
  unitStarts: number[];
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
const listContinuationOperators = new Set(['&&', '||', '|&', '|']);
const longestRedirection = '<<<';

const separatorLength = (character: string, next: string): number =>
  multiCharacterSeparators.has(character + next) ? 2 : 1;

const isBackgroundSeparator = (character: string, length: number): boolean =>
  character === '&' && length === 1;

const continuesListOnNewline = (character: string, continuesList: boolean): boolean =>
  character === '\n' && continuesList;

const continuesListAfter = (operator: string): boolean => listContinuationOperators.has(operator);

const endsListUnit = (character: string, isBackground: boolean): boolean =>
  isBackground || character === ';' || character === '\n';

// A digit word touching `<` or `>` is a file descriptor. Quoting makes it an ordinary word.
const isIoNumber = (word: string, wordQuoted: boolean, redirectionFollows: boolean) =>
  redirectionFollows && !wordQuoted && /^\d+$/u.test(word);

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

  constructor(source: string) {
    this.source = source;
  }

  // Parse until the end, or until the `)` that closes a `$(` when `closesSubstitution` is set.
  parseList(closesSubstitution: boolean): void {
    const firstCommand = this.commands.length;

    const state: ListState = {
      command: this.startCommand(),
      word: undefined,
      wordQuoted: false,
      wordCommandStart: 0,
      heredocOperator: undefined,
      redirectionTarget: false,
      pendingRedirection: undefined,
      depth: 0,
      unitStarts: [firstCommand],
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
      const fileDescriptor = this.fileDescriptorBeforeRedirection(state);

      this.finishWord(state, true);
      const redirection = this.readRedirection();

      state.heredocOperator = redirection.heredoc ?? state.heredocOperator;
      state.redirectionTarget = redirection.heredoc === undefined;

      state.pendingRedirection =
        redirection.heredoc === undefined
          ? { fileDescriptor, operator: redirection.operator }
          : undefined;

      return true;
    }

    if (character !== '&' || next !== '>') {
      return false;
    }

    this.finishWord(state);
    const operator = this.source.startsWith('&>>', this.position) ? '&>>' : '&>';

    this.position += operator.length;
    state.redirectionTarget = true;
    state.pendingRedirection = { fileDescriptor: undefined, operator };

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

      return false;
    }

    const next = this.source.charAt(this.position + 1);
    const length = separatorLength(character, next);
    const operator = this.source.slice(this.position, this.position + length);
    const isBackground = isBackgroundSeparator(character, length);

    // Bash applies `|&` as `2>&1` after the command's own redirections.
    if (operator === '|&') {
      state.command.redirections.push({ fileDescriptor: 2, operator: '>&', target: '1' });
    }

    if (isBackground) {
      this.backgroundUnit(state);
    }

    const endsUnit = endsListUnit(character, isBackground);

    state.command = this.startCommand();
    state.redirectionTarget = false;
    state.pendingRedirection = undefined;
    state.continuesList = continuesListAfter(operator);
    this.position += length;

    if (endsUnit) {
      state.unitStarts[state.unitStarts.length - 1] = this.commands.length - 1;
    }

    if (character === '\n') {
      this.readPendingHeredocs();
    } else if (character === '(') {
      state.depth += 1;
      state.unitStarts.push(this.commands.length - 1);
    } else if (character === ')') {
      return this.closeGroup(state);
    }

    return false;
  }

  // A trailing `&` backgrounds the whole pipeline or list unit, not only its last command.
  private backgroundUnit(state: ListState): void {
    const start = state.unitStarts.at(-1) ?? 0;

    for (const command of this.commands.slice(start)) {
      command.background = true;
    }
  }

  private closeGroup(state: ListState): boolean {
    if (state.closesSubstitution && state.depth === 0) {
      return true;
    }

    state.depth = Math.max(0, state.depth - 1);

    if (state.unitStarts.length > 1) {
      state.unitStarts.pop();
    }

    return false;
  }

  private finishWord(state: ListState, redirectionFollows = false): void {
    const { word, wordQuoted, heredocOperator, redirectionTarget, pendingRedirection } = state;

    if (word === undefined) {
      return;
    }

    if (heredocOperator === undefined) {
      state.command.words.push(word);

      if (!isIoNumber(word, wordQuoted, redirectionFollows) && !redirectionTarget) {
        state.command.arguments.push(word);
      }

      if (redirectionTarget && pendingRedirection !== undefined) {
        state.command.redirections.push({ ...pendingRedirection, target: word });
      }

      state.redirectionTarget = false;
    } else {
      this.commands.splice(state.wordCommandStart);

      this.pendingHeredocs.push({
        command: state.command,
        delimiter: word,
        expands: !state.wordQuoted,
        stripsTabs: heredocOperator.stripsTabs,
      });

      state.heredocOperator = undefined;
    }

    state.pendingRedirection = undefined;
    state.word = undefined;
    state.wordQuoted = false;
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

  private startCommand(): ShellCommand {
    const command: ShellCommand = {
      words: [],
      arguments: [],
      heredocs: [],
      background: false,
      redirections: [],
    };

    this.commands.push(command);

    return command;
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
      this.parseList(true);

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
    const innerParser = new ShellParser(inner);

    innerParser.parseList(false);
    this.commands.push(...innerParser.commands);

    return `\`${inner}\``;
  }

  private skipComment(): void {
    const end = this.source.indexOf('\n', this.position);

    this.position = end === -1 ? this.source.length : end;
  }

  // Consume one redirection operator. Returns heredoc options when the operator starts a heredoc.
  private readRedirection(): {
    operator: string;
    heredoc: { stripsTabs: boolean } | undefined;
  } {
    const rest = this.source.slice(this.position, this.position + longestRedirection.length);

    if (rest === longestRedirection) {
      this.position += longestRedirection.length;

      return { operator: longestRedirection, heredoc: undefined };
    }

    if (rest.startsWith('<<')) {
      const stripsTabs = rest === '<<-';

      this.position += stripsTabs ? '<<-'.length : '<<'.length;

      return { operator: stripsTabs ? '<<-' : '<<', heredoc: { stripsTabs } };
    }

    const doubled = /^[<>][<>&|]/.test(rest);
    const operator = doubled ? rest.slice(0, 2) : rest.charAt(0);

    this.position += operator.length;

    return { operator, heredoc: undefined };
  }

  private fileDescriptorBeforeRedirection(state: ListState): number | undefined {
    const { word, wordQuoted } = state;

    if (word === undefined || !isIoNumber(word, wordQuoted, true)) {
      return undefined;
    }

    return Number(word);
  }

  private readPendingHeredocs(): void {
    for (const heredoc of this.pendingHeredocs.splice(0)) {
      const body = this.readHeredocBody(heredoc);

      heredoc.command.heredocs.push(body);

      if (heredoc.expands) {
        const bodyParser = new ShellParser(body);

        bodyParser.readExpandingText(undefined, false);
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
