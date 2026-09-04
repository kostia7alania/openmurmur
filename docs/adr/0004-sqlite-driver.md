# ADR-0004: node:sqlite, pinned through Node 26.8.1

**Status:** Accepted · **Date:** 2026-07-29

## Context

The brief sets a minimum SQLite version of **3.53.4**.

`node:sqlite` uses the SQLite library compiled into the Node binary. Installing
a newer `sqlite3` via Homebrew does not change it, and assuming otherwise is a
common and dangerous mistake.

Node 26.5.0 bundled **3.53.3** — one patch below:

```
$ node -e "const{DatabaseSync}=require('node:sqlite');
           console.log(new DatabaseSync(':memory:')
             .prepare('select sqlite_version() v').get().v)"
3.53.3
```

That gap was surfaced by `doctor` rather than hidden. Node 26.7.0 was the first
verified release to bundle **3.53.4**; the repository now pins the current
Node 26.8.1 runtime in `.nvmrc` and `package.json`.

The brief is explicit that this must not be hidden.

## Decision

Use `node:sqlite`, and verify the actual runtime rather than inferring it:

1. `MINIMUM_SQLITE_VERSION = '3.53.4'` is declared in code.
2. `.nvmrc` pins Node 26.8.1, whose bundled `node:sqlite` remains 3.53.4.
3. `package.json` requires Node `>=26.8.1`.
4. `openDatabase()` queries the **actual runtime version** and emits a warning
   if it is below target, naming both versions and explaining that Homebrew will
   not fix it.
5. `openmurmur doctor` reports that runtime value.
6. `openDatabase({ strictVersion: true })` turns the warning into a hard failure
   for anyone who needs that.
7. This ADR records why the dependency is pinned through Node.

## Why the previous gap was acceptable before Node 26.7.0

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

That made the temporary warning acceptable while no Node 26 release had 3.53.4.
Now that the Node 26 line does, the gap is closed and the runtime is pinned.

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

**Block startup below 3.53.4.** Rejected for normal database opens so an older
runtime can still report a helpful diagnostic; available as `strictVersion` for
callers that want a hard stop. `bootstrap` and `doctor` are the user-facing
guards.
