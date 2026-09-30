# Anti-slop provenance

Some rules in [lint/rules](../rules) are ported from
[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop). The source is the copy vendored in
[devdotfast/whiteboard](https://github.com/devdotfast/whiteboard), path `tools/oxlint/anti-slop`, at
commit `e2300beb51f5761fba95ca1cb8cd81a05b21f805`.

The ports follow Tau's code style and run under the `tau` plugin. They use `create` instead of
`createOnce`, share repeated helpers through [lint/shared](../shared), and shorten some messages.

## Ported rules

- `no-module-mocking`: [noModuleMocking.ts](../rules/noModuleMocking.ts)
- `no-object-parameters`: [noObjectParameters.ts](../rules/noObjectParameters.ts)
- `no-reduce-accumulator-copy`: [noReduceAccumulatorCopy.ts](../rules/noReduceAccumulatorCopy.ts)
- `no-reflect-apply`: [noReflectApply.ts](../rules/noReflectApply.ts)
- `no-reflect-get`: [noReflectGet.ts](../rules/noReflectGet.ts)
- `no-unknown-type-aliases`: [noUnknownTypeAliases.ts](../rules/noUnknownTypeAliases.ts)
- `no-widen-then-assert`: [noWidenThenAssert.ts](../rules/noWidenThenAssert.ts). It does not follow
  destructured `const` bindings.
- `require-safety-comment-for-type-assertion`:
  [requireSafetyCommentForTypeAssertion.ts](../rules/requireSafetyCommentForTypeAssertion.ts). It
  accepts only the `SAFETY:` marker and has no options.

## Skipped rules

| Upstream rule                        | Reason                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `no-unknown-parameters`              | Tau's parsers take `unknown`, and `use-unknown-in-catch-callback-variable` requires it. |
| `no-unknown-returns`                 | Tau's record readers return raw JSON as `unknown` for a later validator.                |
| `no-unsafe-dictionary-type`          | `Record<string, unknown>` is Tau's type for narrowing untyped JSON.                     |
| `no-known-value-widening`            | Most fixes would add named types or `satisfies` without a clearer contract.             |
| `no-chained-type-assertions`         | `typescript/no-unsafe-type-assertion` already rejects the `unknown as T` step.          |
| `no-array-filter-map`                | Its fix needs iterator helpers, which the ES2024 TypeScript lib lacks.                  |
| `require-readable-spacing`           | Tau's `@stylistic/padding-line-between-statements` configuration sets blank lines.      |
| `no-conditional-empty-object-spread` | Tau's coding instructions use this spread for optional properties.                      |
| `no-shape-in-symbol-names`           | Left out of this port.                                                                  |
| `no-runtime-typeof`                  | Left out of this port.                                                                  |
| Effect rules                         | Tau does not use Effect.                                                                |

## License

The upstream rules are MIT-licensed:

```text
MIT License

Copyright (c) 2026 Dillon Mulroy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
