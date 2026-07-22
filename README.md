# lore

**Git-native project memory for agents.** Everything is derived from sources of truth (Slack, email, Linear, GitHub, meetings) — except what you explicitly ask it to remember. Ask an agent literally anything about a project and it can find it.

No server, no database service. Text in git is the source of truth; a GitHub Actions cron keeps it fresh; the repo is the deployment.

## How it works

```
lore sync      # connectors → context/streams/   (deterministic, no LLM)
lore extract   # streams → derived artifacts      (LLM fold, no external APIs)

lore grep      # search project memory — from any linked repo, or anywhere with -p
lore recall    # pinned facts + derived artifacts
lore remember  # pin a fact (the only explicit write)
lore mcp       # the same verbs as MCP tools over stdio, for agents
```

Storage and interface are separate layers: context lives in a **context repo**
(usually one per client/project, separate from the code), and the CLI is the
interface — it resolves which context repo applies, keeps a clone in
`~/.lore/cache/`, pulls before reads, pushes writes. Neither agents nor humans
need to know where the files are.

Sync pulls raw material — Slack messages, emails, issues — into `context/streams/` as permalinked markdown. Extract folds new material into structured artifacts:

- **`derived/requests.yaml`** — things people asked for, with status, so they stop getting lost
- **`derived/decisions.yaml`** — what the client and team have declared, each linked to its source
- **`derived/roadmap.yaml`** — prioritized, traceable, pushable to Linear/GitHub as tickets
- **`derived/reports/`** — weekly summary: done, blockers, next, bugs, decisions, requests
- **`facts.yaml`** — the pinned layer: written only via `lore remember`, audited for contradictions against fresh derived data

Every derived item cites its source (Slack permalink, email id, commit). Pins win over derived data on conflict — but derivation flags pins that reality has drifted away from.

## Installation

Requires Node >= 20.12. Context lives in a **dedicated context repo** — create
one (e.g. `your-org/lore-acme`, private) and run `init` inside it. Keeping it
separate from the code repo is deliberate: Slack history usually has a
different audience than the code (contractors, clients), and a standalone repo
has no CI, deploys, or branch protection for the sync to fight. Code repos get
a one-line pointer via [`lore link`](#link-your-project-repos) instead.

### 1. Scaffold

```sh
gh repo create your-org/lore-acme --private --clone && cd lore-acme
npx @nerdburn/lore init
```

This creates:

- `lore.json` — config (edit next)
- `context/` — where everything lives (`facts.yaml`, `streams/`, `derived/`)
- an `AGENTS.md` section pointing agents at `context/` (appended if the file already exists)
- `.gitignore` entries for `.env` and `.lore/`
- `.github/workflows/lore-sync.yml` — the scheduled sync (see [Running it on a schedule](#running-it-on-a-schedule))

Edit `lore.json`: set your project name and the Slack channels to sync. Optionally set a backfill window for the first sync:

```json
{
  "project": "acme",
  "sources": {
    "slack": { "channels": ["#acme", "#acme-dev"], "token": "env:SLACK_TOKEN" }
  },
  "backfill": { "months": 1 }
}
```

### 2. Create the Slack app

A ready-made app manifest is bundled — no clicking through scope config:

```sh
npx @nerdburn/lore manifest slack | pbcopy
```

Then at [api.slack.com/apps](https://api.slack.com/apps): **Create New App → From a manifest** → pick your workspace → paste → **Create**. (Some workspaces require admin approval for new apps.)

The app is read-only by design: no `chat:write`, no event subscriptions, no socket mode. The bot never posts or responds to anything.

### 3. Install the app and get the bot token

On the app's page: **Install App** (under *Settings*) → **Install to Workspace** → allow. Copy the **Bot User OAuth Token** (starts with `xoxb-`).

### 4. Invite the bot to your channels — required

In Slack, in **each channel** listed in `lore.json`:

```
/invite @lore
```

The bot can only read channels it has been invited to. This is the privacy model, not a limitation: `lore.json` says what lore *wants* to sync, invitations control what it *can* sync, and the bot sitting visibly in the member list means a synced channel is never a secret. A whitelisted channel the bot isn't in is skipped with a warning.

### 5. Add the token to `.env` — before first sync

In the repo root (already gitignored by `init`):

```sh
echo 'SLACK_TOKEN=xoxb-your-token-here' > .env
```

Lore loads `.env` from the working directory automatically; real environment variables take precedence (which is how CI/cron provides the token instead). Then validate:

```sh
npx @nerdburn/lore check    # ✓ config valid, ✓ env refs resolve
```

### 6. First sync

```sh
npx @nerdburn/lore sync
git add -A && git commit -m "lore: first sync"
```

The first sync seeds each source's cursor from the `backfill` window and can be slow — Slack throttles `conversations.history` hard for new non-Marketplace apps (as low as ~1 request/minute), and lore waits and resumes automatically on rate limits. Every sync after the first only fetches what's new.

Now open your agent in the repo and ask it something only the Slack history knows.

### Running it on a schedule

A GitHub Actions cron in the context repo is the intended deployment (no
server; the repo is the database). `init` scaffolds it at
`.github/workflows/lore-sync.yml`: daily checkout → `sync` → commit straight
to the default branch. To turn it on, add `SLACK_TOKEN` to the repo's Actions
secrets — or as an org-level secret, since one workspace token serves every
context repo.

Two caveats: GitHub sometimes doesn't register a workflow that arrives in the
repo-creating push — a follow-up commit touching the file fixes it. And GitHub
disables scheduled workflows on repos with ~60 days of no activity, so check
dormant projects occasionally (the sync's own commits count as activity while
there's anything to sync).

### Link your project repos

In each code repo that belongs to this project:

```sh
npx @nerdburn/lore link your-org/lore-acme
```

This writes a one-line `lore.json` pointer (`{"context": "your-org/lore-acme"}`)
and an `AGENTS.md` section telling agents to use the CLI. That's the whole
install — no context files, no workflow, no secrets in the code repo. Any
number of project repos can point at the same context repo.

### Query it — from anywhere

```sh
npx @nerdburn/lore grep "black friday"        # from any linked repo
npx @nerdburn/lore grep -p acme "launch date" # from anywhere, via ~/.lore/registry.json
npx @nerdburn/lore recall                     # pinned facts + derived artifacts
npx @nerdburn/lore remember "client wants launch before Black Friday" -c decisions
```

Reads pull the cache clone first (`--no-pull` to skip); `remember` commits and
pushes the pin immediately. The registry learns project names as a side effect
of use, so `-p <project>` works after the first resolution on that machine.

For agents, `lore mcp` serves the same verbs as MCP tools over stdio
(`lore_grep`, `lore_read`, `lore_recall`, `lore_remember`):

```json
{ "mcpServers": { "lore": { "command": "npx", "args": ["-y", "@nerdburn/lore", "mcp", "-p", "acme"] } } }
```

## Everyday commands

```sh
npx @nerdburn/lore sync       # pull new docs from all sources (run in the context repo)
npx @nerdburn/lore grep "<pattern>" [-p project] [--channel name] [--json]
npx @nerdburn/lore recall [category] [--json]
npx @nerdburn/lore remember "client wants launch before Black Friday" -c decisions
npx @nerdburn/lore link <owner/repo>   # point a project repo at its context repo
npx @nerdburn/lore mcp [-p project]    # MCP tools over stdio
npx @nerdburn/lore check      # validate config + env refs
```

Config lives in `lore.json`; secrets are `env:` references, never values:

```json
{
  "project": "acme",
  "sources": {
    "slack": { "channels": ["#acme", "#acme-dev"], "token": "env:SLACK_TOKEN" }
  },
  "backfill": { "months": 0, "slack": 3 },
  "extract": ["requests", "decisions", "roadmap", "weekly-report"]
}
```

`backfill` seeds the first sync's cursor N months back (per-source overrides supported); after that everything is forward-incremental.

## Status

Early. Working: `init`, `check`, `sync` with the Slack connector, and the full query surface — `link`, `grep`, `recall`, `remember` (with pointer resolution + `~/.lore/cache`), and `mcp`. Next: the `requests` extractor (M2), weekly report (M3). See [docs/SPEC.md](docs/SPEC.md) for the full design — data model, connector interface, extraction contract, security model, milestones.

## Principles

1. Text in git is the source of truth — no binary databases in the repo; any search index is a derived, gitignored cache
2. Everything is derived unless explicitly pinned — derived data is a regenerable cache; only pins are irreplaceable
3. Sync and extraction never mix — connectors don't call LLMs; extraction doesn't call external APIs
4. Provenance is mandatory — every item links back to where it came from
5. Pointers, never credentials — the context stores "see 1Password vault X", not secrets
