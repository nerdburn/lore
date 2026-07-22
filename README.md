# lore

**Git-native project memory for agents.** Everything is derived from sources of truth (Slack, email, Linear, GitHub, meetings) — except what you explicitly ask it to remember. Ask an agent literally anything about a project and it can find it.

No server, no database service. Text in git is the source of truth; a GitHub Actions cron keeps it fresh; the CLI is the interface — the repo is just the database.

## How it works

```
lore setup     # wizard: create a context repo, sync it, link this repo
lore sync      # connectors → context/streams/   (deterministic, no LLM)
lore extract   # streams → derived artifacts      (LLM fold, no external APIs)

lore grep      # search project memory — from any linked repo, or anywhere with -p
lore recall    # pinned facts + derived artifacts
lore remember  # pin a fact (the only explicit write)
lore mcp       # the same verbs as MCP tools over stdio, for agents
```

Storage and interface are separate layers:

- **Storage** is a *context repo* — a plain private git repo, usually one per
  client, separate from the code. Slack history has a different audience than
  code, and a standalone repo has no CI or branch protection for the sync to
  fight. A daily GitHub Action keeps it fresh.
- **Interface** is this CLI. Project repos carry a one-line pointer; the CLI
  resolves it, keeps a clone in `~/.lore/cache/`, pulls before reads, pushes
  writes. Neither agents nor humans need to know where the files live.

Sync pulls raw material into `context/streams/` as permalinked markdown.
Extract folds it into structured artifacts — `derived/requests.yaml`,
`decisions.yaml`, `roadmap.yaml`, weekly reports — every item citing its
source. `facts.yaml` is the pinned layer: written only via `lore remember`,
and it wins over derived data on conflict.

## Setup

### 0. Install the CLI

Requires Node >= 20.12, git, and the [`gh` CLI](https://cli.github.com) (authenticated). Not on npm yet:

```sh
npm install -g github:nerdburn/lore
```

### 1. Create the Slack app — once per workspace

```sh
lore manifest slack | pbcopy
```

At [api.slack.com/apps](https://api.slack.com/apps): **Create New App → From a
manifest** → pick the workspace → paste → **Create**, then **Install App** and
copy the **Bot User OAuth Token** (`xoxb-…`). The app is read-only by design —
no `chat:write`, no events; the bot never posts. One app serves every project
in the workspace: reuse its token for each new context repo.

```sh
export SLACK_TOKEN=xoxb-…   # or put it in .env — never in git
```

### 2. Run the wizard

From inside the project repo:

```sh
cd ~/code/acme
lore setup --channels "#acme,#acme-dev"
```

Every value is a prompt with a derived default — the context repo name comes
from the git remote (`lore-acme`), backfill defaults to 3 months, and the
first run asks which GitHub org context repos belong in (**yours, never the
client's**) and saves it to `~/.lore/config.json`. Setup then creates the
private context repo, scaffolds and pushes it, sets the `SLACK_TOKEN` Actions
secret, verifies the daily sync workflow registered, dispatches the first
sync, and links the repo you're standing in. Agents and scripts pass flags
plus `--yes` to skip prompts.

### 3. Invite the bot — the one step that stays human

In Slack, `/invite @lore` in each channel, then re-run the sync from the
context repo's Actions tab. The bot can only read channels it's been invited
to — that's the consent model, not a limitation: `lore.json` says what lore
*wants*, invitations control what it *can*, and the bot in the member list
means a synced channel is never a secret.

The first sync backfills and can be slow (Slack rate-limits new apps hard;
lore waits and resumes automatically). After that, syncs are incremental.

### 4. Link any other project repos

```sh
cd ~/code/acme-mobile
lore link your-org/lore-acme
```

Writes the one-line `lore.json` pointer and an `AGENTS.md` section — commit
both. That's the entire footprint in a code repo: no context files, no
workflow, no secrets. Any number of repos can point at one context repo.

<details>
<summary>Manual setup (what the wizard does, by hand)</summary>

`lore init` in a fresh repo scaffolds `lore.json`, `context/`, `AGENTS.md`,
and `.github/workflows/lore-sync.yml`. Edit the config, then sync and push:

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

```sh
lore check && lore sync
git add -A && git commit -m "lore: first sync" && git push
gh secret set SLACK_TOKEN --repo your-org/lore-acme
```

Channel names must match Slack exactly (hyphens!). Secrets are always `env:`
references; lore loads `.env` from the working directory, real env vars win.
`backfill` seeds the first sync N months back (per-source overrides
supported); everything after is forward-incremental.

</details>

## Using it

From a linked repo:

```sh
lore grep "black friday"                  # search everything
lore grep -i --channel acme-dev "deploy"  # case-insensitive, one channel
lore recall decisions                     # pinned facts + derived, one category
lore remember "client wants launch before Black Friday" -c decisions
```

From anywhere — `~/.lore/registry.json` learns project names as you use them:

```sh
lore grep -p acme "launch date"
lore --context your-org/lore-acme recall
```

Reads pull the cache first (`--no-pull` to skip). `remember` commits and
pushes the pin immediately — a fact that only exists in a local cache isn't
remembered, it's misplaced. Resolution order: `--context` flag → nearest
`lore.json` walking up from cwd → `-p/--project` via the registry. The cache
is disposable; delete `~/.lore/cache/` any time.

### For agents (MCP)

`lore mcp` serves the query surface over stdio: `lore_grep`, `lore_read`,
`lore_recall`, `lore_remember`. In a linked repo with Claude Code:

```sh
claude mcp add lore -- lore mcp
```

Any MCP client, pinned to a project:

```json
{ "mcpServers": { "lore": { "command": "lore", "args": ["mcp", "-p", "acme"] } } }
```

And [`skills/lore-onboard/SKILL.md`](skills/lore-onboard/SKILL.md) teaches an
agent the whole onboarding (Claude Code: copy to `~/.claude/skills/lore-onboard/`):
run `lore setup --yes` with flags, relay the human steps, re-sync after
invites, verify with a real `lore grep` before declaring success — plus the
rules an agent must not relax (context repos in *your* org, one Slack app per
workspace, tokens never in git).

## Command reference

| Command | What it does |
|---|---|
| `lore setup [owner/repo] [--channels s] [--backfill n] [--org o] [-y]` | wizard: create + scaffold + push a context repo, secret, first sync, link cwd |
| `lore link <owner/repo>` | point a project repo at its context repo |
| `lore grep <pattern> [-i] [--channel s] [--limit n] [--json]` | search streams + facts + derived |
| `lore recall [category] [--json]` | pinned facts + derived artifacts |
| `lore remember <fact> [-c cat] [--by who] [--source url]` | pin a fact; pushes immediately in pointer mode |
| `lore mcp` | MCP server over stdio |
| `lore sync [--backfill]` | pull new docs into `context/streams/` (run in the context repo) |
| `lore extract` | LLM fold: streams → derived artifacts *(not built yet)* |
| `lore init` | scaffold a context repo by hand |
| `lore check` | validate config, connectors, env refs |
| `lore manifest slack` | print the bundled Slack app manifest |

`grep`, `recall`, `remember`, and `mcp` all take `--context <owner/repo>`,
`-p/--project <name>`, and `--no-pull`.

## Troubleshooting

- **`not_in_channel` during sync** — the bot isn't in a listed channel; `/invite @lore` and re-run.
- **`channel #x not found … skipping`** — usually a name mismatch; check the exact name in Slack (hyphens!).
- **Added a channel to an existing config, got 0 docs** — known issue: a new channel's cursor seeds at "now" and `--backfill` refuses once any cursor exists. Workaround: set that channel's cursor in `state.json` to an epoch timestamp at the desired start, then sync.
- **No "lore sync" workflow in the Actions tab** — GitHub sometimes misses workflows pushed in the repo-creating commit; `setup` nudges automatically, otherwise push any commit touching the file.
- **Scheduled syncs stopped after ~2 months of quiet** — GitHub disables cron on inactive repos; re-enable from the Actions tab.
- **`could not pull … using cached copy`** — offline or no read access; queries serve the cache. Delete `~/.lore/cache/<owner>__<repo>` to force a fresh clone.
- **`remember` failed to push** — the pin is committed in the cache clone; fix access and `git -C ~/.lore/cache/<owner>__<repo> push`.

## Status

Early. Working: `setup`, `link`, `init`, `check`, `sync` (Slack connector), and the query surface — `grep`, `recall`, `remember`, `mcp`, with pointer resolution + `~/.lore/cache`. Next: the `requests` extractor (M2), weekly report (M3), fixing per-channel backfill. See [docs/SPEC.md](docs/SPEC.md) for the full design.

## Principles

1. Text in git is the source of truth — no binary databases in the repo; any search index is a derived, gitignored cache
2. Everything is derived unless explicitly pinned — derived data is a regenerable cache; only pins are irreplaceable
3. Sync and extraction never mix — connectors don't call LLMs; extraction doesn't call external APIs
4. Provenance is mandatory — every item links back to where it came from
5. Pointers, never credentials — the context stores "see 1Password vault X", not secrets
