import { ruleTester } from '../fixtures/ruleTester.ts';
import { noUnknownTypeAliasesRule } from './noUnknownTypeAliases.ts';

const hides = (alias: string) => ({ messageId: 'unknownAlias', data: { alias } });

ruleTester.run('no-unknown-type-aliases', noUnknownTypeAliasesRule, {
  valid: [
    'export type Name = string;',
    'export type Box<Value> = { value: Value };\nexport type Named = Box<unknown>;',
    'export type Parsed<Value = string> = Value;\nexport type Name = Parsed;',
    'export type Handler = (input: unknown) => void;',
    'type Value = string;\ntype Fixed = Value;\ntype Generic<Value> = Fixed | Value[];\nexport type Payload = Generic<unknown>;',
  ],
  invalid: [
    { code: 'export type Payload = unknown;', errors: [hides('Payload')] },
    { code: 'export type Maybe = (unknown) | undefined;', errors: [hides('Maybe')] },
    {
      code: 'type Raw = unknown;\nexport type Payload = Raw;',
      errors: [hides('Raw'), hides('Payload')],
    },
    {
      code: 'export type Same<Value> = Value;\nexport type Payload = Same<unknown>;',
      errors: [hides('Payload')],
    },
    {
      code: 'type Raw = unknown;\nexport type Wrap<Raw> = Raw;\nexport type Name = Wrap<string>;',
      errors: [hides('Raw')],
    },
  ],
});
