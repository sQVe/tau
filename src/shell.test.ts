import { describe, expect, it } from 'vitest';

import {
  commandKeywords,
  commandWords,
  parseShellCommands,
  runsRedirectionsOnlyExec,
  shellScriptOf,
  wrapperValueOptions,
} from './shell.js';

const wordsOf = (source: string) =>
  parseShellCommands(source)
    ?.map(({ words }) => words)
    .filter((words) => words.length > 0);

const argumentsOf = (source: string) =>
  parseShellCommands(source)
    ?.map(({ arguments: commandArguments }) => commandArguments)
    .filter((commandArguments) => commandArguments.length > 0);

const backgroundsOf = (source: string): boolean[] | undefined =>
  parseShellCommands(source)
    ?.filter(({ arguments: commandArguments }) => commandArguments.length > 0)
    .map(({ background }) => background);

const groupsOf = (source: string): (number | undefined)[] | undefined =>
  parseShellCommands(source)?.map(({ group }) => group);

const shellIdsOf = (source: string): string[] | undefined =>
  parseShellCommands(source)
    ?.filter(({ arguments: commandArguments }) => commandArguments.length > 0)
    .map(({ shellId }) => shellId);

describe('parseShellCommands', () => {
  it.each([
    ['git commit>out', [['git', 'commit', 'out']]],
    ['git commit&>/dev/null', [['git', 'commit', '/dev/null']]],
    ['git>/dev/null commit', [['git', '/dev/null', 'commit']]],
    ['git 2>&1 commit', [['git', '2', '1', 'commit']]],
    ['git commit<in', [['git', 'commit', 'in']]],
    ['git commit>>out', [['git', 'commit', 'out']]],
    ['git commit>|out', [['git', 'commit', 'out']]],
    ['git commit<<<msg', [['git', 'commit', 'msg']]],
    ['git a&b', [['git', 'a'], ['b']]],
    ['a&&b', [['a'], ['b']]],
  ])('splits redirections from words: %s', (source, expected) => {
    expect(wordsOf(source)).toEqual(expected);
  });

  it('records a background command and its redirections', () => {
    expect(parseShellCommands('cmd 2>/dev/null &')?.[0]).toMatchObject({
      background: true,
      redirections: [{ fileDescriptor: 2, operator: '>', target: '/dev/null' }],
    });

    expect(parseShellCommands('cmd > /tmp/x.log 2>&1 &')?.[0]).toMatchObject({
      background: true,
      redirections: [
        { fileDescriptor: undefined, operator: '>', target: '/tmp/x.log' },
        { fileDescriptor: 2, operator: '>&', target: '1' },
      ],
    });

    expect(parseShellCommands('cmd &>/dev/null &')?.[0]).toMatchObject({
      background: true,
      redirections: [{ fileDescriptor: undefined, operator: '&>', target: '/dev/null' }],
    });
  });

  it('records the implicit stderr duplication of a pipe-and after its own redirections', () => {
    expect(parseShellCommands('cmd 2>/dev/null |& cat &')?.[0]?.redirections).toEqual([
      { fileDescriptor: 2, operator: '>', target: '/dev/null' },
      { fileDescriptor: 2, operator: '>&', target: '1' },
    ]);
  });

  it('does not mark an and-list as background', () => {
    expect(backgroundsOf('cmd && other')).toEqual([false, false]);
  });

  it('marks every command in a background pipeline or list unit', () => {
    expect(backgroundsOf('cmd 2>/dev/null | cat &')).toEqual([true, true]);
    expect(backgroundsOf('cmd 2>/dev/null & cat')).toEqual([true, false]);
    expect(backgroundsOf('cmd && other &')).toEqual([true, true]);
    expect(backgroundsOf('cmd 2>/dev/null && ( other ) &')).toEqual([true, true]);
    expect(backgroundsOf('cmd; other &')).toEqual([false, true]);
  });

  it('backgrounds only the command that ends a list inside a foreground group', () => {
    expect(backgroundsOf('( a; b & )')).toEqual([false, true]);
  });

  it('records the group start on the command that closes the group', () => {
    expect(groupsOf('( a; b ) > out')).toEqual([undefined, undefined, undefined, 1]);
  });

  it('offsets the group of a backtick group into the outer list', () => {
    expect(groupsOf('echo `( a )`')).toEqual([undefined, undefined, undefined, 2]);
  });

  it('gives each pipeline element its own child shell', () => {
    expect(shellIdsOf('a | b | c; d')).toEqual(['0.1', '0.2', '0.3', '0']);
  });

  it('keeps a compound pipeline element in its own child shell', () => {
    expect(shellIdsOf('a | { b; c; }')).toEqual(['0.1', '0.2', '0.2', '0.2']);
    expect(shellIdsOf('a | { b && c; }')).toEqual(['0.1', '0.2', '0.2', '0.2']);
    expect(shellIdsOf('a | { b\nc; }')).toEqual(['0.1', '0.2', '0.2', '0.2']);
    expect(shellIdsOf('{ a; b; } | cat')).toEqual(['0.1', '0.1', '0.1', '0.2']);
  });

  it('keeps an exec in a compound pipeline element out of the parent shell', () => {
    expect(shellIdsOf('a | { exec 2>/dev/null; b; }')).toEqual(['0.1', '0.2', '0.2', '0.2']);
  });

  it('keeps a case pattern paren from closing an enclosing group', () => {
    expect(groupsOf('( case x in a) b ;; esac )')).toEqual([undefined, undefined, undefined, 1, 1]);
  });

  it('reads a case inside a command substitution', () => {
    const commands = parseShellCommands('echo $(case x in a) b ;; c) d ;; esac)');

    expect(commands?.map(({ words }) => words)).toContainEqual(['b']);
    expect(commands?.map(({ words }) => words)).toContainEqual(['d']);
  });

  it('gives a backgrounded unit its own child shell and keeps its members together', () => {
    expect(shellIdsOf('{ exec 2>/dev/null; cmd & } &')).toEqual(['0.2', '0.2.1', '0.2']);
  });

  it('gives a command substitution and a backtick their own child shells', () => {
    expect(shellIdsOf('echo $(true)')).toEqual(['0', '0.1']);
    expect(shellIdsOf('echo `true`')).toEqual(['0', '0.1']);
    expect(shellIdsOf('echo $(true $(false))')).toEqual(['0', '0.1', '0.1.1']);
  });

  it.each([
    ['a pipeline with |&', 'printf example 2>/dev/null |& cat', [false, false]],
    ['a pipeline with |& and a trailing ampersand', 'cmd 2>/dev/null |& cat &', [true, true]],
    [
      'a pipeline broken across a newline with a trailing ampersand',
      'nohup cmd 2>/dev/null |\n  cat &',
      [true, true],
    ],
    [
      'an outer command before a substitution with an inner ampersand',
      'printf example 2>/dev/null; printf "%s" "$(true &)"',
      [false, false, true],
    ],
    [
      'an and-list broken across a newline with a trailing ampersand',
      'nohup cmd 2>/dev/null &&\n  other &',
      [true, true],
    ],
    [
      'an or-list broken across a newline with a trailing ampersand',
      'nohup cmd 2>/dev/null ||\n  other &',
      [true, true],
    ],
    [
      'an and-list broken across a newline without a trailing ampersand',
      'cmd 2>/dev/null &&\n  other',
      [false, false],
    ],
    [
      'a heredoc body command before a background unit',
      'cat <<EOF\n$(touch x 2>/dev/null)\nEOF\nother &',
      [false, true, false],
    ],
    ['an if compound with a trailing ampersand', 'if a; then b; fi &', [true, true, true]],
    ['a brace compound with a trailing ampersand', '{ a; } &', [true, true]],
    ['a negated brace compound with a trailing ampersand', '! { a; } &', [true, true]],
    ['a timed brace compound with a trailing ampersand', 'time { a; } &', [true, true]],
    [
      'a timed brace compound after a time output option',
      'time -o /tmp/x.log { a; } &',
      [false, true],
    ],
    [
      'an external time before a brace argument',
      '/usr/bin/time -o /tmp/x.log { a; } &',
      [false, true],
    ],
    ['a wrapper before a brace argument', 'sudo { a; } &', [false, true]],
    ['an env assignment before a brace argument', 'env FOO=1 { a; } &', [false, true]],
    [
      'a heredoc body read after its owner is backgrounded',
      'cat <<EOF &\n$(grep x 2>/dev/null)\nEOF',
      [true, true],
    ],
    ['a background inside an if compound', 'if a; then b & fi', [false, true, false]],
    [
      'a command before an if compound with a trailing ampersand',
      'a; if b; then c; fi &',
      [false, true, true, true],
    ],
    [
      'an and-list before a backgrounded brace compound',
      'a 2>/dev/null && { b; } &',
      [true, true, true],
    ],
    [
      'a brace compound before a backgrounded and-list',
      '{ b 2>/dev/null; } && c &',
      [true, true, true],
    ],
    [
      'an and-list after a separator before a backgrounded brace compound',
      'a; b 2>/dev/null && { c; } &',
      [false, true, true, true],
    ],
  ])(
    'marks background inside the unit that ends with an ampersand: %s',
    (_name, source, expected) => {
      expect(backgroundsOf(source)).toEqual(expected);
    },
  );

  it('reads a case pattern as words that run nothing', () => {
    expect(wordsOf('case $x in git|commit) echo ok ;; esac')).toEqual([
      ['case', '$x', 'in'],
      ['echo', 'ok'],
      ['esac'],
    ]);

    expect(argumentsOf('case $x in git|commit) echo ok ;; esac')).toEqual([
      ['case', '$x', 'in'],
      ['echo', 'ok'],
      ['esac'],
    ]);
  });

  it.each(['fi', 'done', '}'])(
    'keeps a case pattern that spells the %s keyword out of the command',
    (pattern) => {
      expect(wordsOf(`case x in ${pattern}) echo ok ;; esac`)).toEqual([
        ['case', 'x', 'in'],
        ['echo', 'ok'],
        ['esac'],
      ]);
    },
  );

  it('keeps a quoted case closer out of the command', () => {
    expect(wordsOf("case x in 'esac') echo ok ;; esac")).toEqual([
      ['case', 'x', 'in'],
      ['echo', 'ok'],
      ['esac'],
    ]);
  });

  it('records the command after a case whose pattern list is empty', () => {
    expect(wordsOf('case x in esac; echo ok')).toEqual([
      ['case', 'x', 'in', 'esac'],
      ['echo', 'ok'],
    ]);
  });

  it('records a detached command after a case whose pattern list is empty', () => {
    expect(parseShellCommands('case $x in esac; nohup cmd 2>/dev/null &')).toContainEqual(
      expect.objectContaining({ arguments: ['nohup', 'cmd'], background: true }),
    );
  });

  it('backgrounds only a case pattern list member that ends with an ampersand', () => {
    expect(backgroundsOf('case x in a) b & ;; esac')).toEqual([false, true, false]);
  });

  it('splits an append of both streams', () => {
    expect(parseShellCommands('cmd &>>/tmp/x.log')?.[0]).toMatchObject({
      redirections: [{ fileDescriptor: undefined, operator: '&>>', target: '/tmp/x.log' }],
    });
  });

  it.each([
    ['git 2>&1 commit', [['git', 'commit']]],
    ['git 2>/dev/null commit', [['git', 'commit']]],
    ['git commit>out', [['git', 'commit']]],
    ['git>/dev/null commit', [['git', 'commit']]],
    ['git commit&>/dev/null', [['git', 'commit']]],
    ['git commit<<<msg', [['git', 'commit']]],
    ["echo '2'>out", [['echo', '2']]],
    ['a 2 >out', [['a', '2']]],
    ['git 12>out commit', [['git', 'commit']]],
    ['git tag v2>out', [['git', 'tag', 'v2']]],
    ['echo 2a>out', [['echo', '2a']]],
    ['cat <<EOF arg\nbody\nEOF', [['cat', 'arg']]],
    [
      'git commit > $(git push)',
      [
        ['git', 'commit'],
        ['git', 'push'],
      ],
    ],
  ])('keeps only the arguments bash passes: %s', (source, expected) => {
    expect(argumentsOf(source)).toEqual(expected);
  });

  it.each([
    ['ls # one\nstatus', [['ls'], ['status']]],
    ['# one', []],
    ['ls a#b', [['ls', 'a#b']]],
    ['ls "#x" ; echo', [['ls', '#x'], ['echo']]],
    ['ls # trailing', [['ls']]],
    ['echo @(#foo); ls', [['echo', '@'], ['#foo'], ['ls']]],
    ['(# one\nls)', [['ls']]],
  ])('skips comments only at the start of a word: %s', (source, expected) => {
    expect(wordsOf(source)).toEqual(expected);
  });

  it.each([
    [
      '(cd x); git commit',
      [
        ['cd', 'x'],
        ['git', 'commit'],
      ],
    ],
    ['a ) b', [['a'], ['b']]],
    ['echo $(a (b) c) d', [['echo', '$(a (b) c)', 'd'], ['a'], ['b'], ['c']]],
    ['echo "$(a (b) c)" d', [['echo', '$(a (b) c)', 'd'], ['a'], ['b'], ['c']]],
    ['echo $(a ((b)) c) d', [['echo', '$(a ((b)) c)', 'd'], ['a'], ['b'], ['c']]],
  ])('tracks parenthesis nesting: %s', (source, expected) => {
    const actual = wordsOf(source);

    expect(actual?.length).toBe(expected.length);
    expect(actual).toEqual(expect.arrayContaining(expected));
  });

  it.each([
    ['bash -c "git commit -m $msg"', [['bash', '-c', 'git commit -m $msg']]],
    ['echo "a$b c"', [['echo', 'a$b c']]],
    ['echo "a\\$b"', [['echo', 'a$b']]],
    ['echo "a\\`b"', [['echo', 'a`b']]],
    ['echo "a\\"b"', [['echo', 'a"b']]],
    ['echo "a\\\\b"', [['echo', 'a\\b']]],
    ['echo "a\\nb"', [['echo', 'a\\nb']]],
    ['echo "a\\\nb"', [['echo', 'ab']]],
    ['echo "a$\'x\'b"', [['echo', "a$'x'b"]]],
    ['echo "a$"b', [['echo', 'a$b']]],
  ])('reads double-quoted text: %s', (source, expected) => {
    expect(wordsOf(source)).toEqual(expected);
  });

  it.each([
    ['echo a\\\nb', [['echo', 'ab']]],
    ['echo a\\ b', [['echo', 'a b']]],
    ['echo a\\', [['echo', 'a\\']]],
    ['echo a\\\n', [['echo', 'a']]],
    ['echo \\\nb', [['echo', 'b']]],
  ])('reads backslashes outside quotes: %s', (source, expected) => {
    expect(wordsOf(source)).toEqual(expected);
  });

  it.each([
    [
      'echo `a \\$b`',
      [
        ['echo', '`a $b`'],
        ['a', '$b'],
      ],
    ],
    [
      'echo `a \\\\ b`',
      [
        ['echo', '`a \\ b`'],
        ['a', ' b'],
      ],
    ],
    [
      'echo `a \\nb`',
      [
        ['echo', '`a \\nb`'],
        ['a', 'nb'],
      ],
    ],
  ])('reads backticks: %s', (source, expected) => {
    const actual = wordsOf(source);

    expect(actual?.length).toBe(expected.length);
    expect(actual).toEqual(expect.arrayContaining(expected));
  });

  it.each([
    ["echo $'a b'", ['echo', 'a b']],
    ["echo $'a\\'b'", ['echo', "a'b"]],
    ["echo $'a\\\\' b", ['echo', 'a\\', 'b']],
    ['echo $"a b"', ['echo', 'a b']],
    ['echo $"a $b"', ['echo', 'a $b']],
    ['echo $"a$\'b\'"', ['echo', "a$'b'"]],
    ['echo $ b', ['echo', '$', 'b']],
    ['echo $', ['echo', '$']],
    ['echo a$', ['echo', 'a$']],
    [`echo \${a:-commit}`, ['echo', `\${a:-commit}`]],
    [`echo \${a}b`, ['echo', `\${a}b`]],
    [`echo \${a:-$'\\x41'}`, ['echo', `\${a:-A}`]],
    [`echo "\${a:-$'b'}"`, ['echo', `\${a:-$'b'}`]],
    ['echo $(a)b', ['echo', '$(a)b']],
  ])('reads dollar forms: %s', (source, expected) => {
    expect(wordsOf(source)?.[0]).toEqual(expected);
  });

  it.each([
    ["$'com\\x6dit'", 'commit'],
    ["$'\\x6'", '\u0006'],
    ["$'\\x'", '\\x'],
    ["$'com\\x{6d}it'", 'commit'],
    ["$'com\\x{06Dit'", 'commit'],
    ["$'com\\x{2000000000006d}it'", 'commit'],
    ["$'com\\155it'", 'commit'],
    ["$'\\0'", ''],
    ["$'\\1555'", 'm5'],
    ["$'com\\u006dit'", 'commit'],
    ["$'\\U0001F600'", '\u{1F600}'],
    ["$'\\U0010FFFF'", '\u{10FFFF}'],
    ["g$'\\U00110000'it", 'g\uFFFDit'],
    ["$'\\cA\\c?'", '\u0001\u007F'],
    ["$'\\ca\\c1\\c\\\\x'", '\u0001\u0011\u001Cx'],
    ["$'\\c'", '\\c'],
    ["$'com\\0x'mit", 'commit'],
    ["$'com\\x{}x'mit", 'commit'],
    ["$'\\u'", '\\u'],
    ["$'\\a\\b\\e\\E\\f\\n\\r\\t\\v'", '\u0007\b\u001B\u001B\f\n\r\t\v'],
    ["$'\\\\\\'\\\"\\?'", '\\\'"?'],
    ["$'\\q'", '\\q'],
  ])('decodes ANSI-C escapes: %s', (source, expected) => {
    expect(wordsOf(source)).toEqual([[expected]]);
  });

  it.each([
    "echo $'abc",
    "echo $'abc\\",
    'echo `abc',
    'echo `abc\\',
    'echo ${abc',
    'echo $(abc',
    "echo 'abc",
    'echo "abc',
    'echo "abc\\',
  ])('rejects unterminated input: %s', (source) => {
    expect(parseShellCommands(source)).toBeUndefined();
  });

  it.each(['cat <<;', 'cat <<-;', 'cat << )'])(
    'rejects a heredoc without a delimiter: %s',
    (source) => {
      expect(parseShellCommands(source)).toBeUndefined();
    },
  );

  it.each(['cat <<', 'cat <<-'])(
    'rejects a heredoc operator with no delimiter at the end of the source: %s',
    (source) => {
      expect(parseShellCommands(source)).toBeUndefined();
    },
  );

  it('reads a heredoc body after the line ends', () => {
    expect(parseShellCommands('cat <<EOF\nbody\nEOF\nnext')).toEqual([
      {
        words: ['cat'],
        arguments: ['cat'],
        heredocs: ['body\n'],
        background: false,
        shellId: '0',
        redirections: [],
      },
      {
        words: ['next'],
        arguments: ['next'],
        heredocs: [],
        background: false,
        shellId: '0',
        redirections: [],
      },
    ]);
  });

  it('reads a heredoc body after a continued line', () => {
    const commands = parseShellCommands('cat <<EOF &&\nbody\nEOF\nnext');

    expect(commands?.[0]?.heredocs).toEqual(['body\n']);
    expect(commands?.map(({ words }) => words)).toEqual([['cat'], ['next']]);
  });

  it('keeps a heredoc body command inside a backtick in the background unit', () => {
    expect(backgroundsOf('echo `cat <<EOF\n$(touch x 2>/dev/null)\nEOF` &')).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('keeps a heredoc body command inside a command substitution in the background unit', () => {
    expect(backgroundsOf('echo $(cat <<EOF\n$(touch x 2>/dev/null)\nEOF\n) &')).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('strips leading tabs from the delimiter line only for <<-', () => {
    expect(parseShellCommands('cat <<-EOF\n\tbody\n\tEOF\nnext')?.[0]?.heredocs).toEqual([
      '\tbody\n',
    ]);

    expect(parseShellCommands('cat <<EOF\n\tEOF\nEOF\nnext')?.[0]?.heredocs).toEqual(['\tEOF\n']);
  });

  it('does not treat <<< as a heredoc', () => {
    expect(parseShellCommands('cat <<< word\nnext')).toEqual([
      {
        words: ['cat', 'word'],
        arguments: ['cat'],
        heredocs: [],
        background: false,
        shellId: '0',
        redirections: [{ fileDescriptor: undefined, operator: '<<<', target: 'word' }],
      },
      {
        words: ['next'],
        arguments: ['next'],
        heredocs: [],
        background: false,
        shellId: '0',
        redirections: [],
      },
    ]);
  });

  it.each(["<<'EOF'", '<<"EOF"', '<<\\EOF', '<<E"O"F', "<<$'EOF'", '<<$"EOF"', '<<E\\OF'])(
    'does not parse the body of a heredoc with a quoted delimiter: %s',
    (operator) => {
      const commands = parseShellCommands(`cat ${operator}\n$(git commit)\nEOF\n`);

      expect(commands?.flatMap(({ words }) => words)).toEqual(['cat']);
    },
  );

  it('parses the body of a heredoc with an unquoted delimiter', () => {
    const commands = parseShellCommands('cat <<EOF\n$(git commit)\nEOF\n');

    expect(commands?.map(({ words }) => words)).toContainEqual(['git', 'commit']);
  });

  it('parses the body of a heredoc after a quoted word of another command', () => {
    const commands = parseShellCommands("echo 'x'\ncat <<EOF\n$(git commit)\nEOF\n");

    expect(commands?.map(({ words }) => words)).toContainEqual(['git', 'commit']);
  });

  it('splits words at tabs', () => {
    expect(wordsOf('git\tcommit')).toEqual([['git', 'commit']]);
  });

  it('keeps command substitution text in one word across separators', () => {
    const actual = wordsOf('echo $(a; b | c & d\ne) f');

    expect(actual?.[0]).toEqual(['echo', '$(a; b | c & d\ne)', 'f']);
    expect(actual).toContainEqual(['e']);
  });

  it('lists commands from backticks inside double quotes', () => {
    const actual = wordsOf('echo "a `git commit`"');

    expect(actual).toEqual([
      ['echo', 'a `git commit`'],
      ['git', 'commit'],
    ]);
  });

  it('reads the body of a heredoc that starts the source', () => {
    const commands = parseShellCommands('<<EOF cat\n$(git commit)\nEOF\n');

    expect(commands?.map(({ words }) => words)).toContainEqual(['git', 'commit']);
  });

  it('reads an empty heredoc when the source ends after the operator', () => {
    expect(parseShellCommands('cat <<EOF')).toEqual([
      {
        words: ['cat'],
        arguments: ['cat'],
        heredocs: [''],
        background: false,
        shellId: '0',
        redirections: [],
      },
    ]);
  });

  it('keeps the heredoc body free of a phantom line at the end of the source', () => {
    expect(parseShellCommands('cat <<EOF\nbody\n')?.[0]?.heredocs).toEqual(['body\n']);
  });

  it('strips every leading tab, and only leading tabs, before comparing the delimiter', () => {
    expect(parseShellCommands('cat <<-ab\na\tb\nab\nnext')?.[0]?.heredocs).toEqual(['a\tb\n']);

    const commands = parseShellCommands('cat <<-EOF\n\t\tEOF\nnext');

    expect(commands?.[0]?.heredocs).toEqual(['']);
    expect(commands?.map(({ words }) => words)).toContainEqual(['next']);
  });

  it.each([
    ['an unquoted $(...) delimiter', 'cat <<$(git commit)\nbody\n$(git commit)\n', [['cat']]],
    ['a quoted $(...) delimiter', 'cat <<"$(git commit)"\nbody\n$(git commit)\n', [['cat']]],
    ['an unquoted backtick delimiter', 'cat <<`git commit`\nbody\n`git commit`\n', [['cat']]],
    ['a double-quoted backtick delimiter', 'cat <<"`git commit`"\nbody\n`git commit`\n', [['cat']]],
    [
      'an unquoted $(...) delimiter with a body that expands',
      'cat <<$(git commit)\n$(git push)\n',
      [['cat'], ['git', 'push']],
    ],
    [
      'a quoted $(...) delimiter with a body that does not expand',
      'cat <<"$(git commit)"\n$(git push)\n',
      [['cat']],
    ],
    [
      'several unquoted substitutions in one delimiter',
      'cat <<$(git commit)$(git push)\nbody\n',
      [['cat']],
    ],
  ])('adds no commands from %s', (_label, source, expected) => {
    expect(wordsOf(source)).toEqual(expected);
  });

  it.each(['`EOF`', '$(echo EOF)', `\${E}`, '$'])(
    'parses the body of a heredoc whose delimiter is %s',
    (delimiter) => {
      const commands = parseShellCommands(`cat <<${delimiter}\n$(git commit)\n${delimiter}\n`);

      expect(commands?.map(({ words }) => words)).toContainEqual(['git', 'commit']);
    },
  );
});

const wrapperOptions = Object.entries(wrapperValueOptions).flatMap(([name, options]) =>
  [...options].map((option) => ({ name, option })),
);

const wrapperFixedArguments = (name: string): string[] =>
  ['chroot', 'flock', 'timeout'].includes(name) ? ['root'] : [];

describe('commandWords and shellScriptOf', () => {
  it.each(wrapperOptions)(
    'reads the command head past the $name option $option',
    ({ name, option }) => {
      const words = [name, option, 'value', ...wrapperFixedArguments(name), 'sh', '-c', 'cmd'];

      expect(commandWords(words).words).toEqual(['sh', '-c', 'cmd']);
      expect(shellScriptOf(words)).toBe('cmd');
    },
  );

  it.each([...commandKeywords])('reads the command head past the %s keyword', (keyword) => {
    const words = [keyword, 'sh', '-c', 'cmd'];

    expect(commandWords(words).words).toEqual(['sh', '-c', 'cmd']);
    expect(shellScriptOf(words)).toBe('cmd');
  });

  it('reads the -c script only before a shell operand', () => {
    expect(shellScriptOf(['bash', 'script.sh', '-c', 'hc send'])).toBeUndefined();
    expect(shellScriptOf(['sh', '--', 'script', '-c', 'hc send'])).toBeUndefined();
    expect(shellScriptOf(['bash', '-x', 'script.sh', '-c', 'hc send'])).toBeUndefined();
    expect(shellScriptOf(['bash', '-o', 'pipefail', '-c', 'cmd'])).toBe('cmd');
    expect(shellScriptOf(['bash', '-euo', 'pipefail', '-c', 'cmd'])).toBe('cmd');
    expect(shellScriptOf(['bash', '--rcfile', '/tmp/rc', '-c', 'cmd'])).toBe('cmd');
    expect(shellScriptOf(['bash', '-lc', 'cmd'])).toBe('cmd');
  });

  it('reads the script after a flag word that sets -c and takes a value', () => {
    expect(shellScriptOf(['bash', '-co', 'pipefail', 'cmd 2>/dev/null &'])).toBe(
      'cmd 2>/dev/null &',
    );

    expect(shellScriptOf(['bash', '-cO', 'pipefail', 'cmd'])).toBe('cmd');
  });

  it('reads the command the external time binary runs', () => {
    expect(commandWords(['/usr/bin/time', '-o', '/tmp/log', 'hc', 'send']).words).toEqual([
      'hc',
      'send',
    ]);

    expect(shellScriptOf(['/usr/bin/time', '-o', '/tmp/log', 'sh', '-c', 'cmd'])).toBe('cmd');
  });

  it('treats only -p and -- as the reserved time word options', () => {
    expect(commandWords(['time', '-p', 'hc', 'send']).words).toEqual(['hc', 'send']);
    expect(commandWords(['time', '--', 'hc', 'send']).words).toEqual(['hc', 'send']);
    expect(commandWords(['time', '--', '-p', 'hc', 'send']).words).toEqual(['-p', 'hc', 'send']);

    expect(commandWords(['time', '-o', '/tmp/log', 'hc', 'send']).words).toEqual([
      '-o',
      '/tmp/log',
      'hc',
      'send',
    ]);
  });

  it('reads a flock script option before and after the lock file', () => {
    expect(shellScriptOf(['flock', '-c', 'cmd 2>/dev/null', '/tmp/lock'])).toBe('cmd 2>/dev/null');
    expect(shellScriptOf(['flock', '/tmp/lock', '-c', 'cmd 2>/dev/null'])).toBe('cmd 2>/dev/null');
  });

  it('reads a flock script from an inline option value', () => {
    expect(shellScriptOf(['flock', '--command=cmd 2>/dev/null', '/tmp/lock'])).toBe(
      'cmd 2>/dev/null',
    );
  });

  it('reads a flock script option after the lock file and its other options', () => {
    expect(shellScriptOf(['flock', '/tmp/lock', '-w', '5', '-c', 'cmd 2>/dev/null'])).toBe(
      'cmd 2>/dev/null',
    );
  });

  it('reads the command flock runs after the lock file and its other options', () => {
    const words = ['flock', '/tmp/lock', '-w', '5', 'sh', '-c', 'cmd 2>/dev/null'];

    expect(commandWords(words).words).toEqual(['sh', '-c', 'cmd 2>/dev/null']);
    expect(shellScriptOf(words)).toBe('cmd 2>/dev/null');
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'treats the %s command name as an ordinary command',
    (name) => {
      expect(() => commandWords([name, '-x'])).not.toThrow();
      expect(commandWords([name, '-x'])).toEqual({ words: [name, '-x'], lookup: false });
      expect(shellScriptOf([name, '-x'])).toBeUndefined();
    },
  );

  it('joins the words watch hands to its shell', () => {
    expect(shellScriptOf(['watch', '-n', '1', 'cmd 2>/dev/null'])).toBe('cmd 2>/dev/null');
  });

  it('marks a command lookup instead of a command', () => {
    expect(commandWords(['command', '-v', 'sh', '-c', 'cmd'])).toEqual({
      words: ['sh', '-c', 'cmd'],
      lookup: true,
    });

    expect(commandWords(['command', '-p', '--', 'hc', 'send'])).toEqual({
      words: ['hc', 'send'],
      lookup: false,
    });

    expect(shellScriptOf(['command', '-v', 'sh', '-c', 'cmd'])).toBeUndefined();
  });
});

it.each([
  { name: 'a bare exec', words: ['exec'], runs: true },
  { name: 'an exec with a name option', words: ['exec', '-a', 'name'], runs: true },
  { name: 'a negated exec', words: ['!', 'exec'], runs: true },
  { name: 'a timed exec', words: ['time', 'exec'], runs: true },
  {
    name: 'a timed exec after the portability flag',
    words: ['time', '-p', 'exec'],
    runs: true,
  },
  {
    name: 'a timed exec after an external time output option',
    words: ['/usr/bin/time', '-o', '/tmp/x.log', 'exec'],
    runs: false,
  },
  { name: 'a command-qualified exec', words: ['command', 'exec'], runs: true },
  { name: 'a builtin-qualified exec', words: ['builtin', 'exec'], runs: true },
  { name: 'an exec that runs a command', words: ['exec', 'cmd'], runs: false },
  { name: 'an env exec', words: ['env', 'exec'], runs: false },
  { name: 'a sudo exec', words: ['sudo', 'exec'], runs: false },
  { name: 'a command lookup of exec', words: ['command', '-v', 'exec'], runs: false },
  { name: 'a command that is not exec', words: ['cmd'], runs: false },
])('decides whether $name changes this shell', ({ words, runs }) => {
  expect(runsRedirectionsOnlyExec(words)).toBe(runs);
});
