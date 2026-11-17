# github-core-clone-01-v2

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Singhaxbt/github-core-clone-01-v2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Singhaxbt/github-core-clone-01-v2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node 22 process. It serves git smart HTTP (protocol v2 and v0), the REST v3 API, GraphQL v4 and MCP from one in-memory store built on real SHA-1 git objects — no UI, no outside service, no git binary.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=$MAKEFUN_SHOP_TOKEN node main.ts
```

The forge binds an ephemeral port, prints it, and registers it with the trial environment at `MAKEFUN_ENV_URL` when that variable is set. Without it the process keeps serving on the printed port until stopped. `MAKEFUN_TRIAL_NOW` sets the clock every stamped time comes from (it defaults to the scenario epoch); the forge never reads the wall clock, so two runs on the same instance leave identical state.

## Layout

- `main.ts` — entrypoint: listen, register, poll `/done`, exit 0.
- `app.ts` — wiring: builds the forge and the HTTP server around it.
- `lib/store.mjs` — the in-memory forge: repositories, git objects, refs, issues, pull requests, and the caches.
- `lib/gitobj.mjs` — SHA-1 objects, trees, commits, tags, packfiles, pkt-lines.
- `lib/git-http.mjs` — smart HTTP: advertisements, ls-refs, fetch, receive-pack.
- `lib/rest.mjs` — REST v3: repos, refs, branches, commits, contents, labels, issues, pulls.
- `lib/graphql.mjs` — GraphQL v4: a small parser plus the query, mutation, node and introspection resolvers.
- `lib/mcp.mjs` — MCP over Streamable HTTP: discover, initialize, tools/list, tools/call.
- `lib/scenario.mjs` — the seeded scenario the suite's data derives from (viewer, names, paths, blobs, commits, issues, pulls).
- `lib/server.mjs` — HTTP plumbing: routing, auth, request ids, JSON discipline.
- `lib/util.mjs` — shared helpers.

## Design notes

**One store, four surfaces.** Repositories, objects, refs, issues and pull requests live in a single `Forge`. Git, REST, GraphQL and MCP are thin adapters over it, so a commit pushed over smart HTTP shows up in `GET /commits`, a GraphQL `closeIssue` shows up in a REST issue read, and an MCP `merge_pull_request` is the same merge the REST endpoint performs.

**Real git objects.** Blobs, trees, commits and tags are hashed and stored exactly as git hashes them, packs are built and read with varint headers and zlib streams (plain objects and both delta forms on read), and fetch honours depth, haves, shallow boundaries and unshallowing. A fetch answers `acknowledgments` only when the request carries haves — sending it unconditionally makes real `git clone` fail.

**Fast where the clock runs.** Parsed commits and trees are cached (objects never change), a whole fetch response is cached per repository revision (a fetch is a pure function of the repo's objects plus its arguments), a linear push whose only parent is the old tip skips the ancestry walk, single-issue reads serve a cached serialized view with O(1) lookup by number (invalidated on every mutation), and the HTTP path avoids work it does not need: string operations on the request line, query parsing only when a query is present, and no body stream wait on GETs.

**Determinism.** All timestamps come from `MAKEFUN_TRIAL_NOW`, the scenario is derived from one fixed seed, and no request carries a wall-clock reading or an unseeded random value.

---

<sub>Entered on [make.fun](https://make.fun/?ref=cnrz2rkm&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
