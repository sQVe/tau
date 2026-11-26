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
  // The redirections that apply to the command, in source order.
  inputs: ShellInput[];
  // The heredoc bodies the command owns, in source order. Only an expanding body has a scope.
  heredocs: ShellHeredoc[];
  // The parenthesis nesting depth of the command inside its scope, so a subshell keeps its own
  // directory.
  depth: number;
  // The substitution that runs the command: '' for the top list, and `0`, `0.1`, and so on for
  // each nested `$(...)`, backtick body, or expanding heredoc body.
  scope: string;
}

type Redirection =
  | { kind: 'heredoc'; stripsTabs: boolean }
  | {
      kind: 'input' | 'inputOutput' | 'duplicate' | 'hereString' | 'output' | 'outputDuplicate';
    };

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
  // The redirection whose target word comes next, if any.
  pendingRedirection: Redirection | undefined;
  // The file descriptor word that preceded the pending redirection.
  redirectionDescriptor: string | undefined;
  depth: number;
  closesSubstitution: boolean;
}

export const quoteShellArgument = (argument: string): string =>
  /^[A-Za-z0-9_./@%+=:,-]+$/u.test(argument)
    ? argument
    : `'${argument.replaceAll("'", String.raw`'\''`)}'`;

const blankCharacters = new Set([' ', '\t']);
const separatorCharacters = new Set([';', '&', '|', '\n', '(', ')']);
const longestRedirection = '<<<';

// An unquoted digit word names a file descriptor only where a redirection operator touches it.
const isUnquotedDigitWord = (word: string, wordQuoted: boolean) =>
  !wordQuoted && /^\d+$/u.test(word);

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

// `0>&N` feeds standard input from descriptor N, while every other `>&` form is output.
const isStdinDescriptor = (descriptor: string | undefined): boolean =>
  descriptor !== undefined && Number(descriptor) === 0;

const inputKind = (
  kind: Redirection['kind'],
  descriptor: string | undefined,
  word: string,
): ShellInputKind | undefined => {
  if (kind === 'input' || kind === 'inputOutput') {
    return 'file';
  }

  if (kind === 'duplicate' || kind === 'hereString') {
    return kind;
  }

  if (
    kind === 'outputDuplicate' &&
    isStdinDescriptor(descriptor) &&
    isUnquotedDigitWord(word, false)
  ) {
    return 'duplicate';
  }

  return undefined;
};

const recordWord = (state: ListState, word: string) => {
  state.command.words.push(word);

  const redirection = state.pendingRedirection;

  if (redirection === undefined) {
    state.command.arguments.push(word);

    return;
  }

  const kind = inputKind(redirection.kind, state.redirectionDescriptor, word);

  if (kind !== undefined) {
    state.command.inputs.push({ descriptor: state.redirectionDescriptor, kind, target: word });
  }
};

// Split shell source into simple commands after quote removal. Commands inside `$(...)`,
// backticks, process substitutions, and expanding heredoc bodies are listed as well, because the
// shell runs them. Parameter expansions stay unexpanded, and substitutions keep their source text.
class ShellParser {
  readonly commands: ShellCommand[] = [];
  private readonly source: string;
  private position = 0;
  private readonly pendingHeredocs: PendingHeredoc[] = [];
  private scope: string;
  private childScopes = 0;

  constructor(source: string, scope = '') {
    this.source = source;
    this.scope = scope;
  }

  // Each substitution or expanding heredoc body runs in its own scope, named by its parent and an
  // ordinal that is unique within the parse.
  private childParser(source: string, scope: string): ShellParser {
    return new ShellParser(source, scope);
  }

  private nextChildScope(): string {
    const ordinal = this.childScopes;

    this.childScopes += 1;

    return this.scope === '' ? String(ordinal) : `${this.scope}.${ordinal}`;
  }

  private parseSubstitution(): void {
    const parent = this.scope;

    this.scope = this.nextChildScope();

    try {
      this.parseList(true);
    } finally {
      this.scope = parent;
    }
  }

  // Parse until the end, or until the `)` that closes a `$(` when `closesSubstitution` is set.
  parseList(closesSubstitution: boolean): void {
    const state: ListState = {
      command: this.startCommand(0),
      word: undefined,
      wordQuoted: false,
      wordCommandStart: 0,
      heredocOperator: undefined,
      pendingRedirection: undefined,
      redirectionDescriptor: undefined,
      depth: 0,
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

  // Returns true when this token closes the substitution being parsed.
  private readListToken(state: ListState): boolean {
    const character = this.source.charAt(this.position);
    const next = this.source.charAt(this.position + 1);

    if (character === '#' && state.word === undefined && !this.opensExtendedGlob()) {
      this.skipComment();
    } else if (blankCharacters.has(character)) {
      this.finishWord(state);
      this.position += 1;
    } else if (character === '<' || character === '>') {
      this.finishWord(state, true);
      const redirection = this.readRedirection();

      if (state.pendingRedirection !== undefined) {
        state.redirectionDescriptor = undefined;
      }

      if (redirection.kind === 'heredoc') {
        state.heredocOperator = redirection;
        state.pendingRedirection = undefined;
      } else {
        state.pendingRedirection = redirection;
      }
    } else if (character === '&' && next === '>') {
      this.finishWord(state);
      this.position += 2;
      state.pendingRedirection = { kind: 'output' };
    } else if (separatorCharacters.has(character)) {
      return this.readSeparator(state, character);
    } else {
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
    this.position += 1;

    if (character === '(') {
      state.depth += 1;
    } else if (character === ')') {
      if (state.closesSubstitution && state.depth === 0) {
        return true;
      }

      state.depth = Math.max(0, state.depth - 1);
    }

    state.command = this.startCommand(state.depth);
    state.pendingRedirection = undefined;
    state.redirectionDescriptor = undefined;

    if (character === '\n') {
      this.readPendingHeredocs();
    }

    return false;
  }

  private finishWord(state: ListState, redirectionFollows = false): void {
    const { word, wordQuoted, heredocOperator } = state;

    if (word === undefined) {
      return;
    }

    if (heredocOperator !== undefined) {
      this.finishHeredocDelimiter(state, word, heredocOperator.stripsTabs);
    } else if (
      redirectionFollows &&
      state.pendingRedirection === undefined &&
      isUnquotedDigitWord(word, wordQuoted)
    ) {
      state.command.words.push(word);
      state.redirectionDescriptor = word;
    } else {
      recordWord(state, word);

      state.pendingRedirection = undefined;
      state.redirectionDescriptor = undefined;
    }

    state.word = undefined;
    state.wordQuoted = false;
  }

  private finishHeredocDelimiter(state: ListState, word: string, stripsTabs: boolean): void {
    this.commands.splice(state.wordCommandStart);

    state.command.inputs.push({
      descriptor: state.redirectionDescriptor,
      kind: 'heredoc',
      target: '',
    });

    this.pendingHeredocs.push({
      command: state.command,
      delimiter: word,
      expands: !state.wordQuoted,
      stripsTabs,
    });

    state.heredocOperator = undefined;
    state.redirectionDescriptor = undefined;
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
      this.parseSubstitution();

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
    const innerParser = this.childParser(inner, this.nextChildScope());

    innerParser.parseList(false);
    this.commands.push(...innerParser.commands);

    return `\`${inner}\``;
  }

  private skipComment(): void {
    const end = this.source.indexOf('\n', this.position);

    this.position = end === -1 ? this.source.length : end;
  }

  // Consume one redirection operator.
  private readRedirection(): Redirection {
    const rest = this.source.slice(this.position, this.position + longestRedirection.length);

    if (rest === longestRedirection) {
      this.position += longestRedirection.length;

      return { kind: 'hereString' };
    }

    if (rest.startsWith('<<')) {
      const stripsTabs = rest === '<<-';

      this.position += stripsTabs ? '<<-'.length : '<<'.length;

      return { kind: 'heredoc', stripsTabs };
    }

    if (rest.startsWith('<>')) {
      this.position += '<>'.length;

      return { kind: 'inputOutput' };
    }

    if (rest.startsWith('<&')) {
      this.position += '<&'.length;

      return { kind: 'duplicate' };
    }

    if (rest.startsWith('>&')) {
      this.position += '>&'.length;

      return { kind: 'outputDuplicate' };
    }

    const doubled = /^[<>][<>&|]/.test(rest);
    const isInput = rest.startsWith('<') && !doubled;

    this.position += doubled ? 2 : 1;

    return { kind: isInput ? 'input' : 'output' };
  }

  private readPendingHeredocs(): void {
    for (const heredoc of this.pendingHeredocs.splice(0)) {
      const body = this.readHeredocBody(heredoc);
      const scope = heredoc.expands ? this.nextChildScope() : undefined;

      heredoc.command.heredocs.push({ body, scope });

      if (scope !== undefined) {
        const bodyParser = this.childParser(body, scope);

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
