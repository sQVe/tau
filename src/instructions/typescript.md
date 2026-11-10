# Tau TypeScript instructions

- Model variants as a discriminated union, not as a bag of optional fields or a second boolean that
  must stay in sync with the first.
- Use the simplest total type. Make a type stricter, such as `[T, ...T[]]`, only where the loose
  type forces a `!`, a cast, or a "should never happen" throw.
- Infer types from the repository's schema library, such as TypeBox `Static<typeof Schema>`, before
  you write a type guard by hand.
- A type guard must check every claim its type makes.
- Brand a primitive only when a concrete signature shows a real risk of mixing values up.
- Use `satisfies` instead of `as` to check a literal without widening it.
