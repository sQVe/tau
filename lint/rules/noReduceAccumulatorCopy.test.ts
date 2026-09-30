import { ruleTester } from '../fixtures/ruleTester.ts';
import { noReduceAccumulatorCopyRule } from './noReduceAccumulatorCopy.ts';

const copy = { messageId: 'accumulatorCopy' };

ruleTester.run('no-reduce-accumulator-copy', noReduceAccumulatorCopyRule, {
  valid: [
    'export const total = [1].reduce((sum, item) => sum + item, 0);',
    `export const values = [1].reduce((result: number[], item) => {
      result.push(item);

      return result;
    }, []);`,
    'export const merged = [{ a: 1 }].reduce((result, item) => Object.assign(result, item), {});',
    "export const text = ['a'].reduce((result, item) => result.concat(item), '');",
    'export const copies = [{ a: 1 }].map((item) => Object.assign({}, item));',
    `export const lists = [1].reduce((result: number[], item) => {
      const read = function () {
        return Array.from(result);
      };

      result.push(item, read().length);

      return result;
    }, []);`,
  ],
  invalid: [
    {
      code: 'export const merged = [{ a: 1 }].reduce((result, item) => Object.assign({}, result, item), {});',
      errors: [copy],
    },
    {
      code: 'export const all = [[1]].reduce((result, item) => result.concat(item), []);',
      errors: [copy],
    },
    {
      code: `export const values = [1].reduce((result: number[], item) => {
        const copied = Array.from(result);

        copied.push(item);

        return copied;
      }, []);`,
      errors: [copy],
    },
    {
      code: `const start: number[] = [];

export const values = [1].reduce((result, item) => {
  const previous = result;

  return previous.toSorted().concat(item);
}, start);`,
      errors: [copy],
    },
  ],
});
