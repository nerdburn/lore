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

## Quickstart

```sh
npx @nerdburn/lore init     # scaffold lore.json + context/ + AGENTS.md pointer
# edit lore.json, set env keys (SLACK_TOKEN, …)
npx @nerdburn/lore check    # validate config + env refs
npx @nerdburn/lore sync     # pull new docs
npx @nerdburn/lore remember "client wants launch before Black Friday" -c decisions
```

### Slack app setup

A ready-made app manifest is bundled — no clicking through scope config:

```sh
npx @nerdburn/lore manifest slack | pbcopy
```

Then at [api.slack.com/apps](https://api.slack.com/apps): **Create New App → From a manifest** → pick your workspace → paste → create. Install the app, copy the Bot User OAuth Token into `SLACK_TOKEN`, and `/invite @lore` in each channel you whitelisted in `lore.json`. The bot can only read channels it's been invited to — that's the privacy model.

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
