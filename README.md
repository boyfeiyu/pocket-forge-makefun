# pocket-forge-makefun

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/boyfeiyu/pocket-forge-makefun/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/boyfeiyu/pocket-forge-makefun/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An original, dependency-free in-memory Git forge for Node 22. This is a **candidate with submission pending**. Badges are the required template, not a claim of rank or reward.

## Run it

```sh
MAKEFUN_LOGIN=boyfeiyu MAKEFUN_SHOP_TOKEN=local-development-token node main.ts
```

The server prints its ephemeral port. With `MAKEFUN_ENV_URL` set, it registers that port with the suite, polls `/done`, and exits successfully only when the suite finishes. Without it, the HTTP server remains available for independent use. No installation or model gateway is needed.

All endpoints except `/healthz` require `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`.
Set `MAKEFUN_LOGIN` for an explicit single-user namespace. When no login is provided (the suite supplies only an opaque token), the first repository namespace request binds the single principal; subsequent foreign namespaces return 404. Do not expose this bootstrap mode to untrusted clients.

## Design

- `store.ts`: repositories, issue/PR numbering, comments, labels, three-way file merges.
- `objects.ts`: SHA-1 blobs/trees/commits/tags, reachability, zlib packs and delta unpacking.
- `rest.ts`: REST v3 repository, contents, refs, branches, commit, issue and pull operations.
- `git.ts`: smart HTTP upload-pack v2 and v0, receive-pack v0, sidebands and fast-forward validation.
- `graphql.ts`: document tokenizer/parser, variables, aliases, selection execution, fragments, cursor connections, mutations, batching and schema probes.
- `mcp.ts`: initialize/discover and six tools over JSON-RPC, sharing the same store.
- `server.ts` and `main.ts`: HTTP/auth and suite lifecycle.

## Limits

State is memory-only and lost on restart. This is a single-principal forge, not a multi-tenant service. It is a bounded compatibility implementation, not all of GitHub or GraphQL: no UI, persistence, SSH, LFS, hooks, subscriptions, general GitHub search, or production authorization management. Merge conflict detection is file-level (no line-level automatic merge). GraphQL introspection describes the supported subset, not GitHub's entire schema. Only SHA-1 git objects are supported. The transport buffers requests with a 128 MiB cap. No git subprocess or external forge/network service is used.

## Local verification

Use the untouched public kit under Node 22:

```sh
node ../github-core-clone-01-kit/cli/makefun.mjs grade-local \
  --kit ../github-core-clone-01-kit --bot . --driver process --worktree \
  --save /tmp/pocket-forge-verification
```

Local results are advisory, not server results or a submission receipt. No referral code is asserted.

### Build-stage evidence

`node --test test/*.test.ts` exercises canonical Git hashing, nested trees,
pack round-trips/checksums, REST state, namespace isolation, squash merge
conflicts, GraphQL parsing/execution, MCP identity, HTTP-handler serialization,
and receive/fetch packet framing. Latest repair run: **10 passed, 0 failed**
on Node `v22.23.5`, saved in `verification/repair-regressions-after.tap`.
These are in-process tests, not an HTTP conformance grade.

The coordinator's post-repair **LOCAL process-driver grade** used the untouched
official kit on Node `v22.23.5`. Saved evidence is in
`../verification/grade-02/summary.json` and each trial's state export:

| Public practice instance | Checks | Feature | Agent | Performance | Score | Working |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 120/120 | 600 | 200 | 200 | 1000 | 1 |
| 1 | 120/120 | 600 | 200 | 200 | 1000 | 1 |
| 2 | 120/120 | 600 | 200 | 200 | 1000 | 1 |

All three finished with no timeout or nondeterminism. Live/replay states
matched byte-for-byte, and L1 reproduced. Runtime inference requests were
zero; that does **not** measure the cost of coding this project.

This measures local code behavior, not server score, receipt, rank or prize
eligibility. Transcripts were omitted, so authorship and submission eligibility
were not established. Server dev grading uses only trial 0; hidden final
instances differ. The reported harness metadata mismatch (`v26.13.1` versus
local `v22.23.5`) remains advisory; the required entry runtime is Node 22.
Earlier socket restrictions affected only the separate coding sandbox, not
the task host. Raw logs and the local operational report are excluded from
public source; publication and any submission remain coordinator-owned.
