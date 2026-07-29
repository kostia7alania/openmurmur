# ADR-0005: Biome instead of ESLint

**Status:** Accepted · **Date:** 2026-07-29

## Context

TypeScript 7 is the native (Go) compiler and does **not** expose a stable
compiler API. `typescript-eslint` depends on that API for type-aware linting, so
the usual ESLint + `typescript-eslint` + Prettier stack cannot run against
TypeScript 7 today.

That leaves three options: downgrade TypeScript to keep the linter, drop
type-aware linting, or use a linter that does not need the compiler API.

## Decision

Use Biome 2.5.6 for both linting and formatting. Do **not** downgrade TypeScript
for the sake of a linter.

## Rationale

The type checker is the primary correctness tool; the linter is secondary.
Trading TypeScript 7 — with `erasableSyntaxOnly`, which is what makes Node's
native `.ts` execution work — for lint rules would be backwards.

Much of what type-aware lint rules catch is already covered by the compiler
settings this project enables: `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`,
`useUnknownInCatchVariables`.

Biome also replaces Prettier, so one tool and one config file cover both jobs.

## Consequences

**Positive.** One dependency instead of a dozen. Roughly 30 ms to check 54
files. No `.eslintrc` / `.prettierrc` / plugin-version compatibility matrix.

**Negative.** No type-aware rules such as `no-floating-promises` — mitigated by
explicit `void` markers and by the compiler settings above. Biome's rule set is
smaller than ESLint's ecosystem. Some rules had to be tuned:

- `useLiteralKeys` is **disabled** because it directly contradicts
  `noPropertyAccessFromIndexSignature` in `tsconfig.json`. The type-level rule
  is the one worth keeping; the style rule loses.
- `noExcessiveCognitiveComplexity` is set to 24 and treated as a warning. It
  produced one genuinely useful signal (a 150-line `runDoctor`, since
  decomposed into independent check functions).

Biome did catch a real bug that the type checker did not: `noSelfCompare`
flagged `x?.length ?? 0 > 0`, which parses as `x?.length ?? (0 > 0)` and made
an assertion meaningless.

## Revisit

When TypeScript exposes a stable compiler API and `typescript-eslint` supports
it, re-evaluate whether type-aware rules justify the added dependency weight.
