---
name: lore-onboard
description: Set up lore project memory for a client or project — create the context repo, sync Slack history, link project repos. Use when asked to "set up lore", "add project memory", "onboard <client> to lore", or link a repo to existing project memory.
---

# Onboarding a project to lore

Lore is git-native project memory: Slack history synced daily into a private
**context repo**, queried through the `lore` CLI (or its MCP server) from
anywhere. Full docs: https://github.com/nerdburn/lore

## Prerequisites — verify before starting

1. `lore --version` works (else: `npm install -g github:nerdburn/lore`)
2. `gh auth status` is logged in and can create repos in the target org
3. `SLACK_TOKEN` is available (env or `.env` in cwd) — the lore Slack app's
   `xoxb-` bot token for the workspace whose channels you're syncing

## Rules that are not yours to relax

- **The context repo goes in the agency's org, never the client's.** Slack
  history has a different audience than code. `lore setup` reads the default
  from `~/.lore/config.json`; if it's unset and you aren't sure which org is
  correct, ask the user — do not infer it from the project repo's remote.
- **One lore Slack app per workspace.** If the workspace already has one,
  reuse its token; never create a duplicate app.
- **Never commit tokens.** `lore.json` carries `env:` references only.

## Procedure

1. **Gather**: which Slack channels (exact names — hyphens matter), how many
   months of backfill (default 3), and which project repo(s) to link.
2. **Run setup from inside the main project repo** so it derives the name and
   links automatically. Use flags — the interactive wizard is for humans:

   ```sh
   cd <project-repo>
   lore setup --channels "#acme,#acme-team" --backfill 3 --yes
   ```

   This creates `<org>/lore-<project>` (private), scaffolds it, pushes, sets
   the `SLACK_TOKEN` secret, verifies the workflow registered, dispatches the
   first sync, and writes the `lore.json` pointer + `AGENTS.md` section in cwd.
3. **Relay the human steps** to the user — you cannot do these:
   - if the workspace has no lore Slack app: `lore manifest slack` and create
     it at api.slack.com/apps ("From a manifest")
   - `/invite @lore` in each channel (a bot can't invite itself — this is
     lore's consent model, not an oversight)
4. **After they confirm the invites**, re-run the sync and watch it:

   ```sh
   gh workflow run lore-sync.yml --repo <org>/lore-<project>
   gh run watch --repo <org>/lore-<project> $(gh run list --repo <org>/lore-<project> --limit 1 --json databaseId --jq '.[0].databaseId')
   ```

   `not_in_channel` or "channel not found — skipping" means a missed invite or
   a misspelled channel; check exact names via the Slack API before retrying.
5. **Link any additional project repos**: `lore link <org>/lore-<project>` in
   each, then commit the two changed files (PR if the repo requires review).
6. **Verify end-to-end before declaring success** — run a real query for
   something only Slack would know:

   ```sh
   lore grep -p <project> -i "<a term from the synced channels>"
   ```

   Zero matches on a channel you know has traffic means the sync didn't
   actually ingest it — investigate, don't hand off.

## Known issues

- Adding a channel to an *existing* context repo doesn't backfill it (cursor
  seeds at "now"). Workaround: set that channel's cursor in `state.json` to an
  epoch timestamp at the desired start, then sync.
- A workflow pushed in the repo-creating commit sometimes doesn't register;
  `lore setup` nudges automatically, but if Actions shows nothing, push any
  commit touching the workflow file.
