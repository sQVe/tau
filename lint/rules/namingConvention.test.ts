import { ruleTester } from '../fixtures/ruleTester.ts';
import { namingConventionRule } from './namingConvention.ts';

const camelCase = (name: string) => ({ messageId: 'name', data: { format: 'camelCase', name } });
const pascalCase = (name: string) => ({ messageId: 'name', data: { format: 'PascalCase', name } });

ruleTester.run('naming-convention', namingConventionRule, {
  valid: [
    'export interface RequestOptions { request_id: string }',
    'export type Result<Value> = Value | null;',
    'export class RequestError extends Error {}',
    "export const { request_id: requestId } = { request_id: 'one' };",
    'export const { omitted: _omitted, ...rest } = { omitted: 1, kept: 2 };',
    'export const unusedParameter = (_event: unknown, value: string) => value;',
    'export const anonymousParameter = (_: unknown, value: string) => value;',
    "import { snake_case } from './external.js';\n\nexport const value = snake_case;",
  ],
  invalid: [
    { code: 'export const MAX_RETRIES = 3;', errors: [camelCase('MAX_RETRIES')] },
    { code: 'export interface requestOptions {}', errors: [pascalCase('requestOptions')] },
    {
      code: 'export type result<value> = value | null;',
      errors: [pascalCase('result'), pascalCase('value')],
    },
    { code: 'export class requestError extends Error {}', errors: [pascalCase('requestError')] },
    {
      code: "export const { request_id } = { request_id: 'one' };",
      errors: [camelCase('request_id')],
    },
    {
      code: 'export const readParameter = (_value: string) => _value;',
      errors: [camelCase('_value')],
    },
    {
      code: 'export const badUnusedName = (_bad_name: unknown, value: string) => value;',
      errors: [camelCase('_bad_name')],
    },
    {
      code: 'export const { omitted: _bad_name, ...rest } = { omitted: 1, kept: 2 };',
      errors: [camelCase('_bad_name')],
    },
  ],
});
