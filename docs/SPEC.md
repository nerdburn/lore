# lore — git-native project memory for agents

*(formerly "projctx")*

**Pitch:** a project memory where everything is derived from sources of truth (Slack, email, Linear, GitHub, meetings) except what a human explicitly asked to remember — and the derived layer audits the remembered layer for staleness. Installed with `npx`, configured with one JSON file, deployed as a GitHub Actions cron. The repo is the database.

**Goal:** ask an agent literally anything about a project and it can find it — who the client is, what was decided, what's on the roadmap, what someone asked for three weeks ago in Slack, how to deploy.

---

## 1. Core principles

1. **Text in git is the source of truth.** No binary SQLite in the repo. Everything is markdown/YAML/JSONL — diffable, greppable, PR-reviewable. Any search index (FTS/embeddings) is a derived, gitignored local cache, rebuildable at any time.
2. **Everything is derived unless explicitly pinned.** Derived data is a cache over real sources and can be deleted and regenerated with zero data loss. Only the pinned layer contains information that exists nowhere else.
3. **Sync and extraction are strictly separated.** Connectors are dumb, deterministic API scripts — they never call an LLM. Extraction is an LLM reading local files — it never calls an external API. Independent cadence, independent debugging, independent cost.
4. **Provenance is mandatory.** Every derived item links back to its source (Slack permalink, email message-id, commit SHA, meeting id) plus author and timestamp. Captured at collection time by connector code, not reconstructed by the LLM.
5. **Pointers, never credentials.** The manifest stores "see 1Password vault X" or env var names — never secrets.

## 2. Repo layout

```
lore.json            # config (sources, backfill, extractors)
state.json              # sync cursors, committed (stateless-host friendly)
context/
  streams/              # raw synced docs — the substrate
    slack/#acme/2026-07-10.md
    email/…
    meetings/…
    linear/…
  manifest.yaml         # mechanically derived project facts
  derived/              # LLM-extracted artifacts
    roadmap.yaml
    decisions.yaml
    requests.yaml
    reports/2026-w28.md
  facts.yaml            # pinned layer (explicit "remember this" only)
.lore/               # gitignored: local search index, embeddings, tmp
```

## 3. Data model

### 3.1 Stream documents (`context/streams/`)

Normalized shape all connectors emit, one markdown file per day/channel (or per email/meeting), metadata in frontmatter:

```yaml
id: slack-C0123-1720624400.123     # stable, source-derived
source: slack
channel: "#acme"
author: Jane (U0AB12)
timestamp: 2026-07-10T14:33:20Z
permalink: https://acme.slack.com/archives/…
thread: 1720620000.456             # optional
```

Idempotent: re-syncing a window produces byte-identical files.

### 3.2 Manifest (`context/manifest.yaml`) — mechanically derived

Regenerated on every sync; never hand-edited. Client/contacts (from config + Linear/CRM), stack (lockfiles, configs), deployment (vercel.json / CI files, environments with credential *pointers*), docs and links, and **who-knows-what** derived from git blame concentration + Slack channel activity + Linear assignments. Every field carries `source:` and `derived:` timestamps.

### 3.3 Derived artifacts (`context/derived/`) — LLM-extracted

Common item envelope for all list artifacts:

```yaml
- id: req-0042            # assigned at first extraction, stable across folds
  text: "Client wants CSV export on the orders page"
  actor: Jane
  date: 2026-07-08
  sources: [<permalink>, …]
  confidence: high        # high | medium | low
```

**`requests.yaml`** — things people asked for, mostly in Slack/email, so they don't get lost. Adds `status: open | acknowledged | done | declined | stale` and `resolution_sources` (the message, commit, or Linear state that resolved it). Anything old and unresolved after backfill lands as `stale — confirm still wanted?`, never `open`.

**`decisions.yaml`** — declarative statements by client or teammates ("we're deferring iOS parity"). Extracted decisions are *candidate pins*: a human (or explicitly instructed agent) can promote one to `facts.yaml`, where contradiction-checking then protects it.

**`roadmap.yaml`** — ordered priority list synthesized from Linear + decisions + requests. Each item traceable to its inputs. Can be pushed out as Linear/GitHub tickets, but **write-back is always an explicit human/agent command, never cron** (see §7).

**`reports/YYYY-wNN.md`** — weekly summary composed from the other artifacts plus git/deploy activity: what was done, blockers, plan for next week, bugs reported, decisions made, client requests. Cron posts it to the project Slack channel every Friday — the tool markets itself.

### 3.4 Pinned layer (`context/facts.yaml`)

The only hand-/agent-written file. Written solely via the `remember` verb (§6). Each pin records the fact, category, who authorized it (Slack user id → the write ACL), when, and optional source link. Reads merge pinned over derived; **pinned wins on conflict, but derivation flags contradictions**: "pin from March says deploys are manual; vercel.json now has auto-deploy — confirm or drop?" Git history is the audit log. Health metric: pins should number dozens, not hundreds — a growing pin category is the signal to build a connector for it.

## 4. Connectors

One interface, all deterministic:

```ts
interface Connector {
  fetch(config: SourceConfig, cursor: Cursor): Promise<{ docs: Doc[]; nextCursor: Cursor }>
}
```

| Source | Auth | Method | Incremental via |
|---|---|---|---|
| Slack | bot token (`channels:history`, `users:read`), invited to whitelisted channels | `conversations.history` + `conversations.replies`, resolve users via `users.list` | last `ts` per channel |
| Email (Gmail) | OAuth | label / `from:client-domain` query — filter is part of config | `historyId` |
| Linear | API key | GraphQL `issues(filter: {updatedAt: {gt: $lastSync}})` | `updatedAt` |
| GitHub | `gh` / token | PRs, commits, releases | since timestamp |
| Meetings (Granola) | API | transcripts + notes for matching folder/label | meeting id |
| Vercel (later) | token | deployments | deployment id |

Cursors live in committed `state.json`.

### Backfill

```json
"backfill": { "months": 1, "slack": 3, "email": 6 }
```

Backfill is not a separate code path — it seeds the initial cursor at `now − N months`; everything after is forward-incremental. Default `months: 0` (forward-only, instant first run). Backfill runs as an explicit, resumable one-time command (`lore sync --backfill`) outside the cron — Slack rate limits for new non-Marketplace apps (~1 req/min on `conversations.history`) can make a multi-month backfill take hours, and it must never block the hourly sync. Backfilled extraction folds chronologically in week-sized chunks so later messages get to resolve earlier requests.

## 5. Extraction (the fold)

Each `extract` run feeds the model: the **current artifact** + **only the stream docs since the last extraction** + **today's date** → returns the updated artifact. Rules:

- Update, don't rewrite: preserve existing item IDs and wording unless new evidence changes them (keeps diffs reviewable, limits nondeterministic churn — this is the fiddliest part of the system; prototype it first).
- Every new/changed item must cite source permalinks.
- Date-aware status: old unresolved items → `stale`, not `open`.
- Contradiction pass: compare pins in `facts.yaml` against fresh derived data; emit a `contradictions` section for human review (or a PR comment).
- Confidence-tag everything; low-confidence extractions are surfaced, not silently included.

Extraction is re-runnable over history: improve a prompt, re-fold — no external API involved.

## 6. Agent access

**Read (v1):** no server. `CLAUDE.md`/`AGENTS.md` points at `context/` — the manifest and artifacts are small enough to read whole; streams are greppable. Any agent with repo access already has everything.

**Write:** a single verb, exposed as CLI + MCP tool:

```
remember(fact, category, authorized_by, source?)
```

Appends to `facts.yaml` and commits. ACL by Slack user id / git identity. Start with direct commits + git log as audit; add PR review only if someone pins something dumb.

**Later:** `lore serve` — a small MCP server exposing hybrid search (FTS5 first; embeddings behind a flag, via sqlite-vec or similar, index in gitignored `.lore/`). Only build this if agentic grep over the markdown demonstrably falls short.

## 7. Write-back

`lore push roadmap 3-5` (or the MCP equivalent) creates Linear/GitHub tickets from roadmap items, recording the created ticket IDs back onto the items. Explicit invocation only; cron never writes to external systems.

## 8. CLI & config

```
npx lore init         # scaffold lore.json + context/, write CLAUDE.md pointer
npx lore sync         # connectors → streams/ + manifest (no LLM)
npx lore sync --backfill
npx lore extract      # LLM fold → derived/ (+ contradiction report)
npx lore check        # validate schemas, config, cursors
npx lore remember …   # append to facts.yaml
npx lore push …       # explicit write-back
```

```json
{
  "project": "acme",
  "sources": {
    "slack":  { "channels": ["#acme", "#acme-dev"], "token": "env:SLACK_TOKEN" },
    "email":  { "query": "from:@acme.com", "auth": "env:GMAIL_CREDS" },
    "linear": { "project": "acme", "token": "env:LINEAR_KEY" },
    "github": { "repos": ["inputlogic/acme-app"] },
    "granola": { "folder": "Acme" }
  },
  "backfill": { "months": 0 },
  "extract": ["requests", "decisions", "roadmap", "weekly-report"],
  "report": { "post_to": "#acme", "day": "friday" }
}
```

Keys always via `env:` references; never in the file.

## 9. Deployment

GitHub Actions cron: checkout → `sync` → `extract` → commit diff → (Fridays) post report to Slack. Secrets in repo secrets. No server, no database service — the repo is the deployment. Everything also runs locally with the same commands.

## 10. Security & permissions

- **Channel whitelist is the permission model.** Only explicitly configured channels sync — never "all channels the bot can see." Syncing flattens Slack's channel-level privacy into repo-level access; whitelisting keeps that a deliberate, reviewable choice.
- **Secrets scrubber on ingest** (token/key/password patterns) before anything is written to `streams/` — git history is forever.
- Manifest stores credential pointers only (§1.5).
- Write ACL on pins by Slack user id.
- Monorepo of projects (per the original idea) means repo access = all projects' context; if clients ever get access, split per-project repos instead.

## 11. Milestones

**M1 — validate before building (this week, no code):** hand-dump a few Slack channels + roadmap + Linear issues as markdown into one real project's repo. Point Claude Code at it, ask the 10 questions you actually want answered. If grep answers 8/10, the product is the connectors; if it fails, note *how* — that decides whether search/structure is needed.

**M2 — the wedge:** Slack connector + `requests.yaml` extractor. "Things people asked for stop getting lost" is the single most felt pain and demos alone.

**M3 — visibility:** weekly report + Friday Slack post. The team sees value without opening anything.

**M4 — the rest:** decisions + roadmap extractors, manifest derivation, email + Granola + Linear connectors, `remember` + contradiction pass.

**M5 — only if needed:** FTS/embeddings index + `lore serve` MCP server; write-back to Linear/GitHub.

## 12. Risks & open questions

- **Extraction churn** (nondeterministic re-phrasing polluting diffs) — mitigated by stable IDs + fold prompting, but it's the top engineering risk; prototype M2 specifically to derisk it.
- **Trust**: one wrong "done" status on a request and people stop believing the tool. Confidence tags + permalinks are the mitigation; err toward `open`.
- **Slack rate limits / plan retention** cap backfill; verify current limits at build time.
- **Privacy comfort**: even whitelisted, teammates should know a channel is synced (bot presence makes it visible, but say it out loud).
- Open: per-project repos vs. monorepo with per-project dirs; where extraction LLM costs land (est. cents/day per project at daily folds); whether reports go to client-visible channels.

## 13. Prior art (steal, don't rebuild)

- Backstage `catalog-info.yaml` — battle-tested schema decisions for in-repo project/service metadata.
- CLAUDE.md / AGENTS.md conventions — the zero-config discovery entry point.
- [sqlite-memory](https://github.com/sqliteai/sqlite-memory), sqlite-vec — the hybrid-search layer if/when M5 happens; don't build search from scratch.
- Linear Asks / Notion AI Slack connectors — the live-query alternative; lore's edge is the synced, greppable, offline, cross-source snapshot with provenance.
