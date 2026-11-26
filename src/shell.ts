type ShellRedirectionOperator =
  | '<'
  | '>'
  | '>>'
  | '>|'
  | '<>'
  | '>&'
  | '<&'
  | '&>'
  | '&>>'
  | '<<'
  | '<<-'
  | '<<<';

export interface ShellRedirection {
  fileDescriptor: number | undefined;
  operator: ShellRedirectionOperator;
  target: string;
}

export interface ShellCommand {
  words: string[];
  // The words bash passes to the command: `words` without file descriptor numbers and redirection
  // targets.
  arguments: string[];
  heredocs: string[];
  background: boolean;
  // The index of the first command inside this command's group, set only on the command that
  // closes the group.
  group: number | undefined;
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
  pendingRedirection:
    | { fileDescriptor: number | undefined; operator: ShellRedirectionOperator }
    | undefined;
  depth: number;
  // The first command index of the pipeline or list unit at each nesting depth.
  unitStarts: number[];
  // The first command index of the group at each nesting depth.
  groupStarts: number[];
  // The open compound keywords, with the first command index of the unit that encloses each.
  compounds: { closer: string; unitStart: number }[];
  continuesList: boolean;
  closesSubstitution: boolean;
}

export interface CommandWords {
  readonly words: readonly string[];
  readonly lookup: boolean;
}

interface CommandStart {
  // The index of the word the shell runs as the command, or the word count when none follows.
  readonly index: number;
  readonly wrappers: readonly { readonly name: string; readonly index: number }[];
  readonly lookup: boolean;
}

// The name a word runs, without its directory.
export const commandNameOf = (word: string): string => word.slice(word.lastIndexOf('/') + 1);

const shellNames: ReadonlySet<string> = new Set([
  'ash',
  'bash',
  'dash',
  'ksh',
  'mksh',
  'sh',
  'zsh',
]);

// A word that runs the command after it instead of being the command itself.
export const commandKeywords: ReadonlySet<string> = new Set([
  '!',
  '{',
  'do',
  'elif',
  'else',
  'if',
  'then',
  'until',
  'while',
]);

// Each wrapper runs the command after its own options and fixed arguments. The set lists the
// options that take the next word as their value.
export const wrapperValueOptions: Readonly<Record<string, ReadonlySet<string>>> = {
  chroot: new Set(['--groups', '--userspec']),
  command: new Set(),
  doas: new Set(['-C', '-a', '-u']),
  env: new Set(['-C', '-S', '-u', '--chdir', '--split-string', '--unset']),
  exec: new Set(['-a']),
  flock: new Set(['-E', '-c', '-w', '--command', '--conflict-exit-code', '--timeout']),
  nice: new Set(['-n', '--adjustment']),
  nohup: new Set(),
  setsid: new Set(),
  stdbuf: new Set(['-e', '-i', '-o', '--error', '--input', '--output']),
  sudo: new Set([
    '-C',
    '-D',
    '-R',
    '-T',
    '-U',
    '-a',
    '-c',
    '-g',
    '-h',
    '-p',
    '-r',
    '-t',
    '-u',
    '--auth-type',
    '--chdir',
    '--chroot',
    '--close-from',
    '--command-timeout',
    '--group',
    '--host',
    '--login-class',
    '--other-user',
    '--prompt',
    '--role',
    '--type',
    '--user',
  ]),
  time: new Set(['-f', '-o', '--format', '--output']),
  timeout: new Set(['-k', '-s', '--kill-after', '--signal']),
  watch: new Set(['-n', '-q', '--equexit', '--interval']),
  xargs: new Set([
    '-a',
    '-d',
    '-E',
    '-I',
    '-L',
    '-n',
    '-P',
    '-s',
    '--arg-file',
    '--delimiter',
    '--eof',
    '--max-args',
    '--max-chars',
    '--max-lines',
    '--max-procs',
    '--process-slot-var',
    '--replace',
  ]),
};

// The fixed arguments a wrapper takes before the command it runs.
const wrapperArguments: Readonly<Record<string, number>> = {
  chroot: 1,
  flock: 1,
  timeout: 1,
};

// The wrappers that run a script through a shell, and the options that name that script. `watch`
// has no option: it joins its remaining words and hands them to `sh -c`.
const scriptWrapperNames: ReadonlySet<string> = new Set(['flock', 'watch']);
const flockScriptOptions: ReadonlySet<string> = new Set(['-c', '--command']);

const emptyOptionValues: ReadonlySet<string> = new Set();
const assignmentPattern = /^[A-Za-z_][A-Za-z0-9_]*=/u;
// `command -v` and `command -V`, also combined with `-p`, describe the command instead of running
// it.
const lookupOptionPattern = /^-p*[vV][pvV]*$/u;

const optionEnd = (
  words: readonly string[],
  start: number,
  valueOptions: ReadonlySet<string>,
): number => {
  let index = start;

  while (index < words.length) {
    const word = words[index] ?? '';

    if (!word.startsWith('-')) {
      return index;
    }

    index += valueOptions.has(word) ? 2 : 1;
  }

  return index;
};

// Walks the leading assignments, keywords, and wrappers to the command they run.
const commandStart = (words: readonly string[]): CommandStart => {
  const wrappers: { name: string; index: number }[] = [];
  let index = 0;
  let lookup = false;

  while (index < words.length) {
    const word = words[index] ?? '';
    const name = commandNameOf(word);

    const valueOptions = Object.hasOwn(wrapperValueOptions, name)
      ? wrapperValueOptions[name]
      : undefined;

    if (commandKeywords.has(word) || assignmentPattern.test(word)) {
      index += 1;
    } else if (valueOptions === undefined) {
      break;
    } else {
      const afterOptions = optionEnd(words, index + 1, valueOptions);
      const options = words.slice(index + 1, afterOptions);

      lookup ||= name === 'command' && options.some((option) => lookupOptionPattern.test(option));
      wrappers.push({ name, index });
      index = afterOptions + (wrapperArguments[name] ?? 0);
    }
  }

  return { index, wrappers, lookup };
};

// The words a wrapper or keyword runs as a command. `lookup` is true when a `command -v` or
// `command -V` wrapper names a command instead of running it.
export const commandWords = (words: readonly string[]): CommandWords => {
  const { index, lookup } = commandStart(words);

  return { words: words.slice(index), lookup };
};

const shellOptionScript = (words: readonly string[]): string | undefined => {
  const optionIndex = words.findIndex((word) => /^-[a-z]*c[a-z]*$/u.test(word));

  return optionIndex === -1 ? undefined : words[optionIndex + 1];
};

const flockCommandPrefix = '--command=';

const scriptOptionValue = (
  words: readonly string[],
  start: number,
  end: number,
): string | undefined => {
  for (let index = start; index < end; index += 1) {
    const word = words[index] ?? '';

    const inlineValue = word.startsWith(flockCommandPrefix)
      ? word.slice(flockCommandPrefix.length)
      : undefined;

    if (inlineValue !== undefined) {
      return inlineValue;
    }

    if (flockScriptOptions.has(word)) {
      return words[index + 1];
    }
  }

  return undefined;
};

// `flock` takes its script as an option value, either before or after the lock file, in the option
// word itself or as the next word.
const flockScript = (words: readonly string[]): string | undefined => {
  const valueOptions = wrapperValueOptions.flock ?? emptyOptionValues;
  const fileIndex = optionEnd(words, 1, valueOptions);
  const beforeFile = scriptOptionValue(words, 1, fileIndex);
  const afterFileEnd = optionEnd(words, fileIndex + 1, valueOptions);
  const afterFile = scriptOptionValue(words, fileIndex + 1, afterFileEnd);

  return beforeFile ?? afterFile;
};

// `watch` joins its remaining words and hands them to `sh -c`, so they are the script text.
const watchScript = (words: readonly string[]): string | undefined => {
  const start = optionEnd(words, 1, wrapperValueOptions.watch ?? emptyOptionValues);
  const script = words.slice(start).join(' ');

  return script === '' ? undefined : script;
};

const wrapperScript = (name: string, words: readonly string[]): string | undefined =>
  name === 'watch' ? watchScript(words) : flockScript(words);

// The script a command runs through a shell: a shell's `-c` word, a wrapper's script option, or
// the words `watch` joins.
export const shellScriptOf = (words: readonly string[]): string | undefined => {
  const { index, wrappers, lookup } = commandStart(words);

  if (lookup) {
    return undefined;
  }

  const headName = commandNameOf(words[index] ?? '');

  if (shellNames.has(headName)) {
    return shellOptionScript(words.slice(index + 1));
  }

  const scriptWrapper = wrappers.findLast(({ name }) => scriptWrapperNames.has(name));

  return scriptWrapper === undefined
    ? undefined
    : wrapperScript(scriptWrapper.name, words.slice(scriptWrapper.index));
};

export const quoteShellArgument = (argument: string): string =>
  /^[A-Za-z0-9_./@%+=:,-]+$/u.test(argument)
    ? argument
    : `'${argument.replaceAll("'", String.raw`'\''`)}'`;

const blankCharacters = new Set([' ', '\t']);
const separatorCharacters = new Set([';', '&', '|', '\n', '(', ')']);
const multiCharacterSeparators = new Set(['&&', '||', '|&']);
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
  private readonly heredocOwners = new Map<ShellCommand, ShellCommand>();

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
      groupStarts: [],
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
      this.readPendingHeredocs();

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
    const commandIndex = this.commands.length;

    state.command = this.startCommand();
    state.redirectionTarget = false;
    state.pendingRedirection = undefined;
    state.continuesList = continuesListAfter(operator);
    this.position += length;

    if (endsUnit) {
      state.unitStarts[state.unitStarts.length - 1] = commandIndex;
    }

    if (character === '\n') {
      this.readPendingHeredocs();
    } else if (character === '(') {
      state.depth += 1;
      state.unitStarts.push(commandIndex);
      state.groupStarts.push(commandIndex);
    } else if (character === ')') {
      return this.closeGroup(state);
    }

    return false;
  }

  // A trailing `&` backgrounds the whole pipeline or list unit, not only its last command. A
  // compound restores the unit start it opened in when it closes, so the whole compound joins the
  // unit. A command parsed from a heredoc body runs when the command that carries the heredoc
  // expands the body, so it joins the background unit only when that command does.
  private backgroundUnit(state: ListState): void {
    const start = state.unitStarts.at(-1) ?? 0;
    const unit = this.commands.slice(start);
    const backgrounded = new Set(unit);

    for (const command of unit) {
      const owner = this.heredocOwners.get(command);

      if (owner === undefined || backgrounded.has(owner)) {
        command.background = true;
      }
    }
  }

  private closeGroup(state: ListState): boolean {
    if (state.closesSubstitution && state.depth === 0) {
      return true;
    }

    state.depth = Math.max(0, state.depth - 1);

    const groupStart = state.groupStarts.pop();

    if (groupStart === undefined) {
      return false;
    }

    if (state.unitStarts.length > 1) {
      state.unitStarts.pop();
    }

    state.command.group = groupStart;

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

        if (state.command.arguments.length === 1 && !wordQuoted) {
          this.trackCompound(state, word);
        }
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

  // A compound keyword runs the commands up to its closer as one unit, so a trailing `&` after the
  // closer backgrounds the whole compound instead of only the closer's command. Closing the
  // compound restores the unit start it opened in, because a separator inside it moved the unit
  // start forward.
  private trackCompound(state: ListState, word: string): void {
    const start = this.commands.indexOf(state.command);
    const closer = Object.hasOwn(compoundClosers, word) ? compoundClosers[word] : undefined;

    if (start === -1) {
      return;
    }

    if (closer !== undefined) {
      const unitStart = state.unitStarts.at(-1) ?? start;

      state.compounds.push({ closer, unitStart });
    } else if (closingKeywords.has(word) && state.compounds.at(-1)?.closer === word) {
      const compound = state.compounds.pop();

      if (compound !== undefined) {
        state.unitStarts[state.unitStarts.length - 1] = compound.unitStart;
      }
    }
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
      group: undefined,
      redirections: [],
    };

    this.commands.push(command);

    return command;
  }

  private offsetCommand(command: ShellCommand, base: number): void {
    if (command.group !== undefined) {
      command.group += base;
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

  // Consume one redirection operator. Returns heredoc options when the operator starts a heredoc.
  private readRedirection(): {
    operator: ShellRedirectionOperator;
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

    const doubled = doubledRedirectionOperators.find((candidate) => rest.startsWith(candidate));
    const single = rest.startsWith('<') ? '<' : '>';
    const operator: ShellRedirectionOperator = doubled ?? single;

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

        const base = this.commands.length;

        for (const command of bodyParser.commands) {
          this.offsetCommand(command, base);
          this.heredocOwners.set(command, heredoc.command);
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
