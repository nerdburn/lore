# lore

**Git-native project memory for agents.** Everything is derived from sources of truth (Slack, email, Linear, GitHub, meetings) — except what you explicitly ask it to remember. Ask an agent literally anything about a project and it can find it.

No server, no database service. Text in git is the source of truth; a GitHub Actions cron keeps it fresh; the repo is the deployment.

## How it works

```
lore sync      # connectors → context/streams/   (deterministic, no LLM)
lore extract   # streams → derived artifacts      (LLM fold, no external APIs)
```

Sync pulls raw material — Slack messages, emails, issues — into `context/streams/` as permalinked markdown. Extract folds new material into structured artifacts:

- **`derived/requests.yaml`** — things people asked for, with status, so they stop getting lost
- **`derived/decisions.yaml`** — what the client and team have declared, each linked to its source
- **`derived/roadmap.yaml`** — prioritized, traceable, pushable to Linear/GitHub as tickets
- **`derived/reports/`** — weekly summary: done, blockers, next, bugs, decisions, requests
- **`facts.yaml`** — the pinned layer: written only via `lore remember`, audited for contradictions against fresh derived data

Every derived item cites its source (Slack permalink, email id, commit). Pins win over derived data on conflict — but derivation flags pins that reality has drifted away from.

## Installation

Requires Node >= 20.12. Lore runs *inside* the repo that should hold the context — usually your project's own repo (agents working on the code then get the memory for free), or a dedicated context repo if repo access is broader than the Slack channels' audience.

### 1. Scaffold

```sh
cd ~/code/your-project
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

A GitHub Actions cron is the intended deployment (no server; the repo is the database). `init` scaffolds it at `.github/workflows/lore-sync.yml`. To turn it on, add `SLACK_TOKEN` to the repo's Actions secrets — or as an org-level secret shared across repos, since one workspace token serves every install.

Sync commits don't land on the default branch directly. The workflow:

1. checks out the branch named in `lore.json` (`"branch": "lore"`), creating it from the default branch if needed
2. runs `sync` and commits to that branch
3. opens (or reuses) a PR into the default branch and squash-merges it — auto-merge if the repo allows it, direct merge otherwise, and leaves the PR open with a warning if branch protection blocks both

So the default branch gets one tidy `chore(lore): context sync [skip ci]` commit per merge instead of per-sync noise, and `git blame` on your code never meets the bot. **The squash-merge means the sync branch and the default branch stop sharing history** — the workflow handles this by resetting the sync branch onto the default branch on the run after a merge. Don't commit your own work to the sync branch; it gets force-pushed.

Deploy safety: pushes and merges made with the built-in `GITHUB_TOKEN` don't trigger other Actions workflows, and the `[skip ci]` in the squash commit title covers external Git integrations (Vercel etc.). Set `"branch": "main"` in `lore.json` and delete the PR steps if you'd rather commit straight to the default branch.

Two caveats: GitHub disables scheduled workflows on repos with ~60 days of no activity — check dormant projects occasionally. And while this repo is private, installs need a `LORE_INSTALL_TOKEN` Actions secret (a read-only PAT for this repo) so `npx` can fetch it; the workflow picks it up automatically and it becomes unnecessary once the package is published to npm.

## Everyday commands

```sh
npx @nerdburn/lore sync       # pull new docs from all sources
npx @nerdburn/lore remember "client wants launch before Black Friday" -c decisions
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

Early. Working: `init`, `check`, `remember`, `sync` with the Slack connector. Next: the `requests` extractor (M2), weekly report (M3). See [docs/SPEC.md](docs/SPEC.md) for the full design — data model, connector interface, extraction contract, security model, milestones.

## Principles

1. Text in git is the source of truth — no binary databases in the repo; any search index is a derived, gitignored cache
2. Everything is derived unless explicitly pinned — derived data is a regenerable cache; only pins are irreplaceable
3. Sync and extraction never mix — connectors don't call LLMs; extraction doesn't call external APIs
4. Provenance is mandatory — every item links back to where it came from
5. Pointers, never credentials — the context stores "see 1Password vault X", not secrets
