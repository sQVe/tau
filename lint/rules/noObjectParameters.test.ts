import { ruleTester } from '../fixtures/ruleTester.ts';
import { noObjectParametersRule } from './noObjectParameters.ts';

const broad = (parameter: string) => ({ messageId: 'objectParameter', data: { parameter } });

ruleTester.run('no-object-parameters', noObjectParametersRule, {
  valid: [
    'export const run = (value: Record<string, string>) => value;',
    'interface Options { name: string }\nexport const run = (options: Options) => options;',
    'export const run = (values: object[]) => values;',
    'export const run = (): object => ({});',
  ],
  invalid: [
    { code: 'export const run = (value: object) => value;', errors: [broad('value')] },
    { code: 'export const run = (value: object | string) => value;', errors: [broad('value')] },
    { code: 'export const run = (value: object = {}) => value;', errors: [broad('value')] },
    { code: 'export const run = ({ name }: object) => name;', errors: [broad('{ name }')] },
    {
      code: 'type Loose = object;\nexport const run = (value?: Loose) => value;',
      errors: [broad('value')],
    },
    {
      code: 'export interface Api { run(value: object): void }',
      errors: [broad('value')],
    },
  ],
});
