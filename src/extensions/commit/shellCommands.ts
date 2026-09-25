export interface ShellCommand {
  words: string[];
  heredocs: string[];
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
  heredocOperator: { stripsTabs: boolean } | undefined;
  depth: number;
  closesSubstitution: boolean;
}

const ansiCEscapes: Record<string, string> = {
  a: '\u0007',
  b: '\b',
  e: '\u001B',
  E: '\u001B',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};

const decodeAnsiCEscape = (escape: string): string => {
  const kind = escape[0] ?? '';

  if ('xuU'.includes(kind) && escape.length > 1) {
    return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
  }

  if (/^[0-7]/.test(escape)) {
    return String.fromCodePoint(Number.parseInt(escape, 8));
  }

  if (kind === 'c') {
    return String.fromCodePoint((escape.codePointAt(1) ?? 0) & 31);
  }

  return ansiCEscapes[escape] ?? escape;
};

// Decode the body of a `$'...'` word the way Bash does.
const decodeAnsiC = (text: string) =>
  text.replaceAll(
    /\\(x[\da-fA-F]{1,2}|u[\da-fA-F]{1,4}|U[\da-fA-F]{1,8}|[0-7]{1,3}|c.|.)/gs,
    (_match, escape: string) => decodeAnsiCEscape(escape),
  );

const blankCharacters = new Set([' ', '\t']);
const separatorCharacters = new Set([';', '&', '|', '\n', '(', ')']);

// Split shell source into simple commands after quote removal. Commands inside `$(...)`,
// backticks, process substitutions, and expanding heredoc bodies are listed as well, because the
// shell runs them. Parameter expansions stay unexpanded, and substitutions keep their source text.
class ShellParser {
  readonly commands: ShellCommand[] = [];
  private position = 0;
  private readonly pendingHeredocs: PendingHeredoc[] = [];

  constructor(private readonly source: string) {}

  // Parse until the end, or until the `)` that closes a `$(` when `closesSubstitution` is set.
  parseList(closesSubstitution: boolean): void {
    const state: ListState = {
      command: this.startCommand(),
      word: undefined,
      wordQuoted: false,
      heredocOperator: undefined,
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
    this.readPendingHeredocs();
  }

  // Read text with double-quote rules until `terminator`, or to the end when it is undefined.
  readExpandingText(terminator: string | undefined): string {
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
        text += this.readDollar().text;
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

    if (character === '#' && state.word === undefined) {
      this.skipComment();
    } else if (blankCharacters.has(character)) {
      this.finishWord(state);
      this.position += 1;
    } else if (character === '<' || character === '>') {
      this.finishWord(state);
      state.heredocOperator = this.readRedirection() ?? state.heredocOperator;
    } else if (character === '&' && next === '>') {
      this.finishWord(state);
      this.position += 2;
    } else if (separatorCharacters.has(character)) {
      return this.readSeparator(state, character);
    } else {
      this.readWordPiece(state, character);
    }

    return false;
  }

  private readWordPiece(state: ListState, character: string): void {
    const piece = this.readWordPieceText(character);

    if (piece === undefined) {
      return;
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

      return { text: this.readExpandingText('"'), quoted: true };
    }

    if (character === '$') {
      return this.readDollar();
    }

    if (character === '`') {
      return { text: this.readBacktick(), quoted: false };
    }

    this.position += 1;

    return { text: character, quoted: false };
  }

  private readSeparator(state: ListState, character: string): boolean {
    this.finishWord(state);

    if (state.heredocOperator !== undefined) {
      throw new Error('Missing heredoc delimiter');
    }

    state.command = this.startCommand();
    this.position += 1;

    if (character === '\n') {
      this.readPendingHeredocs();
    } else if (character === '(') {
      state.depth += 1;
    } else if (character === ')') {
      return this.closeGroup(state);
    }

    return false;
  }

  private closeGroup(state: ListState): boolean {
    if (state.closesSubstitution && state.depth === 0) {
      return true;
    }

    state.depth = Math.max(0, state.depth - 1);

    return false;
  }

  private finishWord(state: ListState): void {
    const { word, heredocOperator } = state;

    if (word === undefined) {
      return;
    }

    if (heredocOperator === undefined) {
      state.command.words.push(word);
    } else {
      this.pendingHeredocs.push({
        command: state.command,
        delimiter: word,
        expands: !state.wordQuoted,
        stripsTabs: heredocOperator.stripsTabs,
      });

      state.heredocOperator = undefined;
    }

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
    const command: ShellCommand = { words: [], heredocs: [] };

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

  private readDollar(): { text: string; quoted: boolean } {
    const start = this.position;
    const next = this.source[this.position + 1];

    this.position += 2;

    if (next === '(') {
      this.parseList(true);

      return { text: this.source.slice(start, this.position), quoted: false };
    }

    if (next === '{') {
      return { text: `\${${this.readExpandingText('}')}}`, quoted: false };
    }

    if (next === "'") {
      return { text: decodeAnsiC(this.readAnsiCBody()), quoted: true };
    }

    if (next === '"') {
      return { text: this.readExpandingText('"'), quoted: true };
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

    return this.source.slice(start, this.position - 1);
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
  private readRedirection(): { stripsTabs: boolean } | undefined {
    const rest = this.source.slice(this.position, this.position + 3);

    if (rest === '<<<') {
      this.position += 3;

      return undefined;
    }

    if (rest.startsWith('<<')) {
      const stripsTabs = rest === '<<-';

      this.position += stripsTabs ? 3 : 2;

      return { stripsTabs };
    }

    const doubled = /^[<>][<>&|]/.test(rest);

    this.position += doubled ? 2 : 1;

    return undefined;
  }

  private readPendingHeredocs(): void {
    for (const heredoc of this.pendingHeredocs.splice(0)) {
      const body = this.readHeredocBody(heredoc);

      heredoc.command.heredocs.push(body);

      if (heredoc.expands) {
        const bodyParser = new ShellParser(body);

        bodyParser.readExpandingText(undefined);
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
