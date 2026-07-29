# ADR-0004: node:sqlite, and the 3.53.3 version gap

**Status:** Accepted · **Date:** 2026-07-29

## Context

The brief sets a minimum SQLite version of **3.53.4**.

Node 26.5.0 bundles **3.53.3** — one patch below:

```
$ node -e "const{DatabaseSync}=require('node:sqlite');
           console.log(new DatabaseSync(':memory:')
             .prepare('select sqlite_version() v').get().v)"
3.53.3
```

This is the SQLite **compiled into the Node binary**. Installing a newer
`sqlite3` via Homebrew does not change it, and assuming otherwise is a common
and dangerous mistake.

The brief is explicit that this must not be hidden.

## Decision

Use `node:sqlite`, and surface the gap rather than paper over it:

1. `MINIMUM_SQLITE_VERSION = '3.53.4'` is declared in code.
2. `openDatabase()` queries the **actual runtime version** and emits a warning
   naming both versions and explaining that Homebrew will not fix it.
3. `openmurmur doctor` reports it as a `⚠️` with that explanation.
4. `openDatabase({ strictVersion: true })` turns the warning into a hard failure
   for anyone who needs that.
5. This ADR records why it is accepted.

## Why the gap is acceptable here

Nothing in the schema depends on a feature newer than 3.53.3:

| Feature used | Available since |
| --- | --- |
| `STRICT` tables | 3.37 |
| FTS5 trigram tokenizer | 3.34 |
| `ON CONFLICT ... DO NOTHING` | 3.24 |
| WAL, partial indexes, `RETURNING` | ≤ 3.35 |

The database is local, single-user, and never parses untrusted SQL — the
attack surface a SQLite patch release typically addresses does not apply. This
is a supply-chain freshness concern, not a functional or security one **for this
usage**.

The gap closes on its own when Node ships a newer SQLite. It is tracked in the
backlog under cross-cutting debt.

## Consequences

**Positive.** No native module, no `node-gyp`, no prebuilt-binary matrix, no
compiler on the user's machine. The version is always verifiable at runtime
rather than inferred from a package version.

**Negative.** The SQLite version is tied to the Node version, so it cannot be
upgraded independently. `node:sqlite` also has a smaller API than
`better-sqlite3` — no user-defined functions, no backup API. Neither is needed.

## Alternatives

**better-sqlite3.** Would let us bundle any SQLite version, and has a richer
API. Rejected: it is a native module requiring a build toolchain or a prebuilt
binary for every Node/OS/arch combination, which is a significant install
barrier and a real supply-chain surface — a worse trade than one patch version.

**Pretend Homebrew's sqlite3 matters.** It does not affect `node:sqlite` at all.
Documenting it as a fix would be actively misleading.

**Block startup below 3.53.4.** Would make the project unusable on every
current Node release for no security benefit given the usage. Available as
`strictVersion` for anyone who wants it.
