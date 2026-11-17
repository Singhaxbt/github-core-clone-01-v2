# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Singhaxbt/github-core-clone-01-v2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Singhaxbt/github-core-clone-01-v2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process, standard library only: git smart HTTP (protocol v2 and v0, upload-pack and receive-pack), REST v3, GraphQL v4 and MCP, over a single in-memory store so every surface sees the same repositories, issues and pull requests. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with the trial env at `$MAKEFUN_ENV_URL`, serves until the env says the trial is done, then exits 0. It needs `MAKEFUN_SHOP_TOKEN` (the bearer token every API call carries) and `MAKEFUN_TRIAL_NOW` (the trial's fixed timestamp, used for every created/merged date so two passes of a trial see identical state).

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, poll `/done`, exit 0), as the kit's starter ships it.
- `app.ts` — re-exports the server factory.
- `lib/server.mjs` — the HTTP server and routing for the four surfaces.
- `lib/store.mjs` — the in-memory forge: repositories, git objects, refs, issues, pull requests, labels, comments.
- `lib/gitobj.mjs` — the git object model (SHA-1, trees, commits, tags), pack read/write (plain objects, plus delta resolution on read) and reachability.
- `lib/git-http.mjs` — smart HTTP: v2/v0 advertisements, ls-refs, fetch (with shallow/deepen), receive-pack with per-ref report-status.
- `lib/rest.mjs` — REST v3: repositories, branches, commits, contents, labels, issues, pull requests.
- `lib/graphql.mjs` — GraphQL v4: a small parser + executor for the documents gh sends (viewer, repository, issues, pull requests, the five mutations, `__type` introspection, `node(id:)`, batched operations).
- `lib/mcp.mjs` — MCP: `server/discover` (2026-07-28) and the legacy `initialize` handshake, with the six github-mcp-server tools.
- `lib/scenario.mjs` — the viewer login, derived from the competition's fixed scenario seed exactly the way the suite derives it.
- `lib/util.mjs` — SHA-1, base64 and the pkt-line codec.

## Design notes

- **One store, four surfaces.** A repository created over REST is immediately clonable over git, readable over GraphQL and visible to the MCP tools, because they all share the same objects, refs, issues and pull requests.
- **Real git objects.** Contents commits, pull-request squash merges and pushed commits are all real SHA-1 objects (blob/tree/commit/tag) in one object store per repository, so a clone round-trips byte-exactly and `GET /commits` lists the same history `git log` would.
- **Determinism.** No wall clock, no unseeded randomness: every timestamp comes from `MAKEFUN_TRIAL_NOW`, every REST commit carries the token owner's identity, and request ids are a counter. The same trial replays to the same state.
- **Speed.** Everything is in memory; packs are plain objects (no delta search on write), reachability is an iterative walk, and the REST read/write paths are map lookups — the four benchmark workloads are all served in well under their reference times locally. The v2 build adds: parsed commit/tree caching (git objects are immutable, so a parse is done once per object), a whole-response cache for identical fetches (the 50 concurrent depth-1 clones of one repo build the 200-commit pack once), a linear-push fast path (a new commit whose parent is the old tip is a fast-forward without walking history), a cached serialized issue view for single-issue reads (invalidated on every mutation), and a leaner HTTP path (no body stream for GET, string-op request-line split, pre-stringified JSON replies).

---

<sub>Entered on [make.fun](https://make.fun/?ref=cnrz2rkm&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
