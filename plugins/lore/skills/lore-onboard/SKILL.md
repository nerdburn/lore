---
name: lore-onboard
description: Set up lore project memory for a client — gather the five facts, create the context repo, wire Slack/GitHub/Granola, verify, and point an agent at it. Use when asked to "set up lore for <client>", "onboard <client>", "add project memory", link a repo to existing memory, connect a Slack agent to lore, or archive a client.
---

# Onboarding a client to lore

Lore is git-native project memory: Slack, GitHub and Granola meetings synced
into a private **context repo** per client, queried through the `lore` CLI or
its MCP server. This skill is the agent-run version of `docs/PLAYBOOK.md`
(also served at the host's page, e.g. https://lore-host.exe.xyz). Walk the
user through it interactively: ask for what only they know, run what you can,
relay the human steps, and verify before declaring success.

## Prerequisites — check first

1. `lore --version` works (else `npm install -g github:nerdburn/lore`, or the
   tarball path in `docs/DEPLOY_EXE.md`)
2. `cat ~/.lore/config.json` — **hosting mode**: `remote` set means
   self-hosted (bare repos on that host, tokens as host integrations, no
   GitHub/Actions/secrets); otherwise GitHub mode. Everything below assumes
   self-hosted; GitHub-mode differences are in the README.
3. `ssh exe.dev integrations list` shows `slack` and a GitHub App connection;
   the host has run `lore auth granola` once.

## Rules that are not yours to relax

- **Context repos live in our infrastructure (our org / our host), never the client's.**
- **One lore Slack app per workspace; never create a duplicate.**
- **No tokens in lore.json** — `env:` refs or proxy `api_base`/`endpoint` only.
- **Whatever lore syncs is readable by every agent pointed at that memory.**
  If the client can talk to such an agent (a `-team` channel here), say so
  before including internal channels or transcripts, and do not enable
  `lore_remember` for a client-facing agent without the user's explicit ok.

## Procedure

1. **Gather** (ask, don't guess): client name + email domains; exact Slack
   channel names (here `#<client>` is internal, `#<client>-team` has the client
   in it); GitHub repos as `owner/repo`; Granola folder title; the client's
   top-level Notion page URL (relay: connect the `lore` integration to it via
   `···` → Connections); Jira project key + site if they track work there;
   whether the client works by email instead of Slack (then: whose inboxes —
   default the team-side contacts — and tell those teammates); backfill months
   (default 3); known contacts (name, email, role, client/team side).
2. **Slack** — relay: `/invite @lore` in each channel. Confirm membership
   before syncing: the bot's channel list is visible via the host's proxy
   (`users.conversations`), or just watch the first sync for `✗ slack:` lines.
3. **GitHub** — one integration per repo, read-only, exe.dev GitHub App:
   `ssh exe.dev integrations add github --name <owner>-<repo> --repository <owner>/<repo> --readonly --attach tag:lore`.
   If the repo isn't found, the app isn't installed on that org — relay
   exe.dev → Integrations → GitHub. Verify:
   `ssh exedev@lore-host.exe.xyz 'curl -s https://github.int.exe.xyz/api/v3/repos/<owner>/<repo> | head -c 200'`.
4. **Create the context repo** — run from inside the client's code repo when
   the user wants it linked (asks about committing the two pointer files:
   keep them local via `.git/info/exclude` if the client can read that repo):

   ```sh
   lore setup --channels "#acme,#acme-team" --github "acme/web" --granola "Acme" \
              --notion "<client's Notion page URL>" [--jira ACM --jira-site https://acme.atlassian.net] \
              [--gmail | --gmail "kaity@inputlogic.ca,shawn@inputlogic.ca"] \
              --client "Acme" --domains "acme.com" --backfill 3 --yes
   ```

   No Slack? Drop `--channels`, pass `--gmail`; the name comes from `--client`.
   Gmail needs the service account key at `~/.lore/gmail-sa.json` on the host
   (one-time, `docs/DEPLOY_EXE.md`); check it exists before the first sync:
   `ssh exedev@lore-host.exe.xyz test -s .lore/gmail-sa.json && echo ok`.
   `--domains` is the whole email search — get it right.

   Then add `client.contacts` to the repo's `lore.json` (cache clone at
   `~/.lore/cache/lore-<client>`), commit, push.
5. **First sync** — don't wait for the timer:
   `ssh exedev@lore-host.exe.xyz 'sudo systemctl start lore-sync.service; sudo journalctl -u lore-sync -o cat --since -30min | tail -40'`.
   Every `✗` is a config problem to fix and re-run (channel not joined, repo
   not integrated, folder title mismatch, `unauthorized_client` = domain-wide
   delegation not granted for a mailbox).
6. **Verify end-to-end** with a real query for something only the client's
   Slack (or email) would know: `lore grep -p <client> -i "<term>"`, then
   `lore recall -p <client>` (client block, derived artifacts, open work,
   freshness). Zero hits on a busy channel means the sync didn't ingest it —
   investigate, don't hand off.
7. **Point an agent at it** (optional, ask): Claude Code users get it from the
   linked repo or `claude mcp add lore -- lore mcp -p <client>`; an enso
   Slack agent VM needs the tag-scoped SSH key, `~/.lore/config.json` remote,
   lore installed, a stdio `lore` server in the policy's `claude/mcp.json`,
   `mcp__lore__*` allow rules, the `lore-mcp` skill in the workspace, and a
   service restart — exact snippets in `docs/PLAYBOOK.md` §7.
8. **Report** what was set up, what is still human, and the first real
   answer you got from the memory.

## Ending an engagement

`lore archive --context lore-<client>` — sync stops, writes are refused,
reads are labelled ARCHIVED, the repo stays. Never delete a context repo.

## Known issues

- The first extract over a full backfill takes minutes and can be dozens of
  LLM batches; `⚠ … model omitted N existing item(s) — kept them` lines are
  normal on commit-only batches.
- `granola: no credentials` on the host → `lore auth granola` there (device
  code; the user approves in a browser).
- Reads on a laptop pull the cache first; `--no-pull` for offline.
