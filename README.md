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

Storage and interface are separate layers:

- **Storage** is a *context repo* — a plain git repo (usually one per client or
  project, private, separate from the code) holding synced history and pinned
  facts. A scheduled GitHub Action keeps it fresh.
- **Interface** is this CLI. It resolves which context repo applies, keeps a
  clone in `~/.lore/cache/`, pulls before reads, pushes writes. Neither agents
  nor humans need to know where the files live.

Sync pulls raw material — Slack messages, emails, issues — into `context/streams/` as permalinked markdown. Extract folds new material into structured artifacts:

- **`derived/requests.yaml`** — things people asked for, with status, so they stop getting lost
- **`derived/decisions.yaml`** — what the client and team have declared, each linked to its source
- **`derived/roadmap.yaml`** — prioritized, traceable, pushable to Linear/GitHub as tickets
- **`derived/reports/`** — weekly summary: done, blockers, next, bugs, decisions, requests
- **`facts.yaml`** — the pinned layer: written only via `lore remember`, audited for contradictions against fresh derived data

Every derived item cites its source (Slack permalink, email id, commit). Pins win over derived data on conflict — but derivation flags pins that reality has drifted away from.

## Installing the CLI

Requires Node >= 20.12 and git. Not yet published to npm — install from GitHub:

```sh
npm install -g github:nerdburn/lore
lore --version
```

(Everything below uses the global `lore`. One-off invocations work too:
`npx --yes github:nerdburn/lore <command>` — that's also how the scheduled
workflow runs it in CI.)

## Setting up a project

Context lives in a **dedicated context repo**. Keeping it separate from the
code repo is deliberate: Slack history usually has a different audience than
the code (contractors, client collaborators), and a standalone repo has no CI,
deploys, or branch protection for the sync to fight. Code repos get a one-line
pointer instead (step 7).

### Quick start: `lore setup`

The scriptable half of the steps below is one command. Run it **inside the
project repo** and it derives the context repo name from the git remote,
creates and scaffolds it, pushes, sets the `SLACK_TOKEN` secret (from your
env/`.env`), verifies the sync workflow registered, dispatches the first sync,
and links the repo you're standing in:

```sh
cd ~/code/acme
lore setup --channels "#acme,#acme-dev"
```

It's an interactive wizard — every value is a prompt with a derived default —
and the first run asks which GitHub org context repos belong in (yours, never
the client's) and saves it to `~/.lore/config.json`. Agents and scripts pass
flags plus `--yes` to skip the prompts.

Two steps stay human, and setup tells you so at the end: creating the Slack
app in a new workspace (step 2) and `/invite @lore` in each channel (step 4).
The numbered steps below are the same process by hand, and the reference for
what setup did.

### 1. Create the context repo and scaffold it

```sh
gh repo create your-org/lore-acme --private --clone && cd lore-acme
lore init
```

This creates:

- `lore.json` — config (edit next)
- `context/` — where everything lives (`facts.yaml`, `streams/`, `derived/`)
- `AGENTS.md` — tells agents what this repo is and how to query it
- `.gitignore` entries for `.env` and `.lore/`
- `.github/workflows/lore-sync.yml` — the daily scheduled sync

Edit `lore.json`: project name, channels, and a backfill window for the first sync:

```json
{
  "project": "acme",
  "sources": {
    "slack": { "channels": ["#acme", "#acme-dev"], "token": "env:SLACK_TOKEN" }
  },
  "backfill": { "months": 3 },
  "extract": ["requests", "decisions", "roadmap", "weekly-report"]
}
```

Channel names must match Slack exactly (watch for missing hyphens — `#acme-corp`
vs `#acmecorp`). Secrets are always `env:` references, never values.

### 2. Create the Slack app — once per workspace

A ready-made app manifest is bundled — no clicking through scope config:

```sh
lore manifest slack | pbcopy
```

Then at [api.slack.com/apps](https://api.slack.com/apps): **Create New App → From a manifest** → pick your workspace → paste → **Create**. (Some workspaces require admin approval for new apps.)

The app is read-only by design: no `chat:write`, no event subscriptions, no socket mode. The bot never posts or responds to anything. One app per workspace serves every project whose channels live there — you reuse its token for each new context repo.

### 3. Install the app and get the bot token

On the app's page: **Install App** (under *Settings*) → **Install to Workspace** → allow. Copy the **Bot User OAuth Token** (starts with `xoxb-`).

### 4. Invite the bot to your channels — required

In Slack, in **each channel** listed in `lore.json`:

```
/invite @lore
```

The bot can only read channels it has been invited to. This is the privacy model, not a limitation: `lore.json` says what lore *wants* to sync, invitations control what it *can* sync, and the bot sitting visibly in the member list means a synced channel is never a secret. A whitelisted channel the bot isn't in is skipped with a warning.

### 5. First sync, locally

```sh
echo 'SLACK_TOKEN=xoxb-your-token-here' > .env   # gitignored by init
lore check                                        # ✓ config valid, ✓ env refs resolve
lore sync
git add -A && git commit -m "lore: first sync" && git push
```

Lore loads `.env` from the working directory automatically; real environment
variables take precedence (which is how CI provides the token instead). The
first sync seeds each source's cursor from the `backfill` window and can be
slow — Slack throttles `conversations.history` hard for new non-Marketplace
apps (as low as ~1 request/minute), and lore waits and resumes automatically
on rate limits. Every sync after the first only fetches what's new.

### 6. Turn on the daily sync

Add the token to the context repo's Actions secrets — or as an org-level
secret shared across repos, since one workspace token serves every context repo:

```sh
gh secret set SLACK_TOKEN --repo your-org/lore-acme
```

The scaffolded workflow runs daily (and on demand via **Actions → lore sync →
Run workflow**), committing new history straight to `main` — a context repo
has nothing to protect with PRs. Verify the first scheduled run actually
registered: if **Actions** shows no "lore sync" workflow, push any commit
touching the workflow file (GitHub sometimes misses workflows that arrive in
the repo-creating push).

### 7. Link your project repos

In each code repo that belongs to this project:

```sh
lore link your-org/lore-acme
```

This writes a one-line `lore.json` pointer (`{"context": "your-org/lore-acme"}`)
and an `AGENTS.md` section telling agents to query via the CLI. Commit both.
That's the whole install — no context files, no workflow, no secrets in the
code repo. Any number of project repos can point at the same context repo.

## Using it

### From a linked repo

```sh
lore grep "black friday"                  # search everything
lore grep -i --channel acme-dev "deploy"  # case-insensitive, one channel
lore grep "refund" --json                 # machine-readable, for scripts
lore recall                               # pinned facts + derived artifacts
lore recall decisions                     # one category
lore remember "client wants launch before Black Friday" -c decisions
lore remember "staging db resets nightly" -c deployment --source https://acme.slack.com/archives/...
```

Reads pull the cache clone first (add `--no-pull` when offline or in a hot
loop). `remember` writes `facts.yaml`, commits, and pushes immediately — a fact
that only exists in a local cache isn't remembered, it's misplaced. Pushing
requires write access to the context repo; the clone uses your normal git
credentials (SSH first, then https).

### From anywhere

```sh
lore grep -p acme "launch date"     # no repo needed: resolve by project name
lore --context your-org/lore-acme recall
```

`~/.lore/registry.json` maps project names to context repos and learns as a
side effect of use — after the first resolution on a machine, `-p acme` works
from any directory. Explicit `--context owner/repo` works cold.

Resolution order, for reference: `--context` flag → nearest `lore.json` walking
up from the current directory (pointer or full config) → `-p`/`--project` via
the registry. The cache lives in `~/.lore/cache/` and is disposable — delete it
any time; the next command re-clones.

### For agents (MCP)

`lore mcp` serves the query surface as MCP tools over stdio: `lore_grep`,
`lore_read` (fetch a file `lore_grep` pointed at), `lore_recall`, and
`lore_remember` (instructed to only pin on explicit user request). Reads
re-pull at most once a minute.

Claude Code, in a linked repo:

```sh
claude mcp add lore -- lore mcp
```

Any MCP client, pinned to a project:

```json
{ "mcpServers": { "lore": { "command": "lore", "args": ["mcp", "-p", "acme"] } } }
```

Agents without the global install can use `"command": "npx", "args": ["--yes", "github:nerdburn/lore", "mcp", "-p", "acme"]`.

### Command reference

| Command | What it does |
|---|---|
| `lore setup [owner/repo] [--channels s] [--backfill n] [--org o] [-y]` | wizard: create + scaffold + push a context repo, secret, first sync, link cwd |
| `lore init` | scaffold a context repo (config, `context/`, AGENTS.md, sync workflow) |
| `lore link <owner/repo>` | point a project repo at its context repo |
| `lore check` | validate config, connectors, env refs |
| `lore sync [--backfill]` | pull new docs into `context/streams/` (run in the context repo) |
| `lore extract` | LLM fold: streams → derived artifacts *(not built yet)* |
| `lore grep <pattern> [-i] [--channel s] [--limit n] [--json]` | search streams + facts + derived |
| `lore recall [category] [--json]` | pinned facts + derived artifacts |
| `lore remember <fact> [-c cat] [--by who] [--source url]` | pin a fact; pushes immediately in pointer mode |
| `lore mcp` | MCP server over stdio |
| `lore manifest slack` | print the bundled Slack app manifest |

`grep`, `recall`, `remember`, and `mcp` all take `--context <owner/repo>`,
`-p/--project <name>`, and `--no-pull`.

## Running a fleet

The shape that scales to many clients: one Slack app per workspace, one
private context repo per client, one org-level `SLACK_TOKEN` secret. Onboarding
client N is:

1. `cd <client-repo> && lore setup --channels "#client,#client-team"`
2. `/invite @lore` in each channel, then re-run the sync from Actions
3. `lore link your-org/lore-<client>` in the client's *other* code repos, if any

### For agents

[`skills/lore-onboard/SKILL.md`](skills/lore-onboard/SKILL.md) is a drop-in
skill (Claude Code: copy to `~/.claude/skills/lore-onboard/`) that teaches an
agent the whole onboarding: run `lore setup --yes` with flags, relay the two
human steps, re-sync after invites, and verify with a real `lore grep` before
declaring success. It also encodes the rules an agent must not relax — context
repos go in *your* org, one Slack app per workspace, tokens never in git.

Offboarding is archiving one repo. Access control follows the data: grant
people (or agents) the context repos they should see, independently of code
access.

## Troubleshooting

- **`not_in_channel` during sync** — the bot isn't in a listed channel yet; `/invite @lore` there and re-run.
- **`channel #x not found or bot not a member — skipping`** — usually a name mismatch; check the exact channel name in Slack (hyphens!).
- **Added a channel to an existing `lore.json` and got 0 docs** — known issue: a new channel's cursor seeds at "now", and `--backfill` currently refuses to run once any cursor exists. Workaround: edit `state.json` and set the new channel's cursor to an epoch timestamp at your desired backfill start, then `lore sync`.
- **First scheduled run never appears in Actions** — push any commit touching `.github/workflows/lore-sync.yml`; GitHub sometimes doesn't register workflows from a repo-creating push.
- **Scheduled syncs stopped after ~2 months of quiet** — GitHub disables cron workflows on inactive repos; re-enable from the Actions tab.
- **`could not pull … using cached copy`** — offline or no read access to the context repo; queries serve the cache. Delete `~/.lore/cache/<owner>__<repo>` to force a fresh clone.
- **`remember` failed to push** — the pin is committed in the cache clone; fix access and `git -C ~/.lore/cache/<owner>__<repo> push`.

## Status

Early. Working: `init`, `check`, `sync` with the Slack connector, and the full query surface — `link`, `grep`, `recall`, `remember` (with pointer resolution + `~/.lore/cache`), and `mcp`. Next: the `requests` extractor (M2), weekly report (M3), fixing per-channel backfill. See [docs/SPEC.md](docs/SPEC.md) for the full design — data model, connector interface, extraction contract, security model, milestones.

## Principles

1. Text in git is the source of truth — no binary databases in the repo; any search index is a derived, gitignored cache
2. Everything is derived unless explicitly pinned — derived data is a regenerable cache; only pins are irreplaceable
3. Sync and extraction never mix — connectors don't call LLMs; extraction doesn't call external APIs
4. Provenance is mandatory — every item links back to where it came from
5. Pointers, never credentials — the context stores "see 1Password vault X", not secrets
