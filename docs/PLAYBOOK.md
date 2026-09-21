# Client onboarding playbook

How to give a client project memory in lore, from zero to an agent answering
questions in Slack. Assumes the self-hosted setup on exe.dev (`lore-host`);
the one-time prerequisites are at the end. Say "set up lore for <client>"
to an agent with the lore plugin and it will walk you through this.

## 0. Gather (five facts)

| Fact | Example | Where it goes |
|---|---|---|
| Client name + email domains | Jointly — `jointly.ca`, `getjointly.ca` | `client` block: scopes meetings, tells extract who is the client |
| Slack channels, exact names | `#jointly` (internal), `#jointly-team` (client is in it) | `sources.slack.channels` |
| GitHub repos, `owner/repo` | `inputlogic/jointly` | `sources.github.repos` + one exe.dev integration each |
| Granola folder title | `Jointly` | `sources.granola.folders` |
| Notion root page(s) or database(s) | the client's top-level Notion page URL | `sources.notion.roots` |
| Figma file(s), if the client has designs | `https://www.figma.com/design/<key>/…` (design, FigJam, or Slides) | `sources.figma.files` |
| Jira project key(s), if the client tracks work in Jira | `ACM` + `https://acme.atlassian.net` | `sources.jira.projects` |
| Email — whose inboxes, if the client works by email (no Slack) | `all` (every Workspace mailbox), or `kaity@…, shawn@…` (default: team-side contacts) | `sources.gmail.users` |
| Backfill window | 3 months | first sync only; after that everything is incremental |

Convention in this workspace: `#<client>` is internal, `#<client>-team` has
the client in it. Whatever lore syncs from either is readable by any agent
you point at the memory — decide which channels to include with that in mind.

## 1. Slack — invite the bot (human)

In each channel: `/invite @lore`. The bot only reads channels it is a member
of; that is the consent model. Nothing else to configure — the workspace's
Slack app and its token already exist as the `slack` integration.

## 2. GitHub — one read-only integration per repo

```sh
ssh exe.dev integrations add github --name <owner>-<repo> --repository <owner>/<repo> --readonly --attach tag:lore
```

Uses exe.dev's GitHub App (no personal token). If the repo doesn't appear,
the app isn't installed on that org yet: exe.dev → Integrations → GitHub.
If an integration for the repo already exists (`ssh exe.dev integrations list`)
but isn't on `tag:lore`, attach it instead of adding a second one:
`ssh exe.dev integrations attach <name> tag:lore` (`--team` when the listing
marks it `(team)`) — until then the host's sync reports "repo not found or
token lacks access". Adding the repo to an existing client is
`lore source add github <owner>/<repo> -p <client>` (or an agent's
`lore_source_add`); the source block alone does nothing without this step.
Verify from the host before relying on it:

```sh
ssh exedev@lore-host.exe.xyz 'curl -s https://github.int.exe.xyz/api/v3/repos/<owner>/<repo> | head -c 200'
```

## 3. Granola — nothing per client

Auth is done once on the host (`lore auth granola`, already done) and the
token refreshes itself. Meetings are matched by the folder title you pass and
by attendee emails at the client's domains, so file meetings into the folder
or just have the client on the call.

## 3b. Notion — share the client's pages with the integration

Once per workspace an internal integration exists as the `notion` exe.dev
proxy. Per client: open the client's top-level Notion page (or teamspace
root) → `···` → Connections → add **lore**. Everything beneath it becomes
readable. Copy that page's URL for `--notion` below.

## 3b′. Figma — share the files with the token's account

Once per workspace a personal access token (any teammate with view access to
the client's designs; Figma → Settings → Security → Personal access tokens,
read-only `file_content:read` + `file_comments:read`) lives as the `figma`
exe.dev http-proxy (`--header "X-Figma-Token:figd_…"` to
`https://api.figma.com`). Per client: make sure that account can open the
file(s), copy the file URL(s) for `--figma` below. Design files and FigJam
boards work (Slides decks are not served by Figma's API — export to PDF and
`lore doc add`); a Figma *project* id in
`sources.figma.projects` takes every file in it.

## 3c. Jira — nothing per project once the site is connected

One Atlassian API token per Jira site lives as the `jira` exe.dev proxy
(HTTP Basic, see `docs/DEPLOY_EXE.md`). The account behind it must be able to
browse the client's project. Pass the project key(s) and site URL to setup.

## 3d. Gmail — for the client who doesn't use Slack

One-time (already done once the service account exists, see prerequisites):
a Google Cloud service account with domain-wide delegation for
`https://www.googleapis.com/auth/gmail.readonly`, its key JSON at
`~/.lore/gmail-sa.json` on the host. Per client: nothing to authorise.
Decide whose inboxes to read — `--gmail all` for every mailbox in the
Workspace (so whoever the client emails is covered; needs the directory
scope, see prerequisites), `--gmail "a@…,b@…"` for a list, or `--gmail` for
the `team`-side contacts — and tell those teammates. Only mail from/to/cc
the client's domains or contacts is synced; a thread seen in several inboxes
is stored once. Make sure `--domains` is right: it is the whole search.
Calendar noise: add `"query": "-subject:\"Invitation:\" -subject:\"Accepted:\""`
to the gmail block when invites match.

## 4. Create the context repo — one command

From inside the client's code repo (links it, derives the name):

```sh
cd ~/Sites/<client>
lore setup --channels "#acme,#acme-team" --github "acme/web" --granola "Acme" \
           --notion "https://www.notion.so/inputlogic/Acme-<id>" \
           --figma "https://www.figma.com/design/<key>/Acme-App" \
           --jira "ACM" --jira-site https://acme.atlassian.net \
           --client "Acme" --domains "acme.com" --backfill 3 --yes
```

From anywhere, with an explicit name and no linking: `lore setup lore-acme --channels …`.
A client without Slack: drop `--channels` and pass `--gmail` (plus
`--granola`/`--notion`/`--figma` as they apply); the name then comes from `--client`.

What it does: creates the bare repo on the host, scaffolds `lore.json` with
proxy-based sources (no tokens anywhere), pushes, and — when run inside a
code repo — writes a one-line `lore.json` pointer plus an `AGENTS.md` section
there. Commit those two files if the code repo is internal; if the client can
read the repo, keep them local (`.git/info/exclude`) and use `-p <client>`.

Then add known contacts so extraction attributes requests and decisions to
the right side. Edit `client.contacts` in the context repo's `lore.json`
(the cache clone at `~/.lore/cache/lore-<client>`), commit, push:

```json
{ "name": "Priya Patel", "email": "priya@acme.com", "role": "Product owner", "side": "client" },
{ "name": "Kaity", "email": "kaity@inputlogic.ca", "role": "PM", "side": "team" }
```

## 5. First sync — trigger it or wait an hour

```sh
ssh exedev@lore-host.exe.xyz 'sudo systemctl start lore-sync.service; sudo journalctl -u lore-sync -o cat --since -30min | tail -40'
```

The first run backfills every source and folds the whole history; expect
minutes, longer for busy repos. Watch for `✗` lines: a channel the bot isn't
in, a repo the integration can't see, a Granola folder title that doesn't
match. Each is a config fix plus a re-run.

## 6. Verify from your laptop

```sh
lore recall -p <client>            # client block, pins, requests/decisions/roadmap, open work, freshness
lore grep -p <client> -i "<something only the client's Slack would know>"
```

Zero hits on a channel you know has traffic means the sync didn't ingest it —
investigate, don't hand off.

## 7. Point an agent at it

**Claude Code (you, teammates):** in the linked repo the plugin's server just
works; anywhere else, `claude mcp add lore -- lore mcp -p <client>`.

**A Slack agent VM (accord-style, enso):** the host serves MCP over HTTP;
the agent VM needs no lore install and no clone. Its identity is the VM name,
which the exe.dev edge stamps on requests that come through a peer integration.

```sh
# once per agent VM: let it reach the host through the lore-mcp peer integration
ssh exe.dev integrations attach lore-mcp vm:<agent-vm>
# on the host: which context(s) that VM may open (writes are attributed to the VM name)
ssh exedev@lore-host.exe.xyz lore agents allow <agent-vm> lore-<client>
```

Then in the policy's `claude/mcp.json`:

```json
"lore": { "type": "http", "url": "https://lore-mcp.int.exe.xyz/mcp/lore-<client>" }
```

(The `lore-mcp` integration exists once per host: `ssh exe.dev integrations add
http-proxy --name lore-mcp --target https://lore-host.exe.xyz/ --peer`. A VM
that is attached but not in the host's agents file gets 403; see
`docs/DEPLOY_EXE.md` §6.)

Then the allow list in `claude/settings.json`. **Do not copy a list from
memory or from an older VM** — three agents were provisioned with a stale
four-tool list that way. Ask the host's binary:

```sh
ssh exedev@lore-host.exe.xyz lore mcp --list-tools      # JSON: [{ name, writes, summary }, …]
```

Allow every tool it prints as `mcp__lore__<name>`, and put the ones the
channel's humans must not trigger in `deny`. The table today (an older lore
prints fewer; the test suite keeps this table equal to what the server
registers):

| tool | writes | what it does |
|---|---|---|
| `lore_grep` | no | regex search across synced memory |
| `lore_read` | no | read a file or line range from the context repo |
| `lore_recall` | no | pins, tracker, derived artifacts, reports, SOWs at once |
| `lore_sync_now` | no | pull, and ask the host to sync (and fold) now |
| `lore_source_list` | no | what is synced: each source, its scope, and its health |
| `lore_remember` | yes | pin a fact — **deny for client-facing agents** unless the user says otherwise |
| `lore_sow_add` | yes | attach a statement of work |
| `lore_doc_add` | yes | attach a document or link the client sent |
| `lore_source_add` | yes | add a source or widen its scope — repo, channel, folder, page, design file, board, mailbox (explicit only; the result names the human steps: invite, integration attach, page share) |
| `lore_work_add` | yes | open a tracker ticket |
| `lore_work_promote` | yes | turn a derived request into a ticket |
| `lore_work_move` | yes | change a ticket status, with a reason |
| `lore_work_set` | yes | priority, assignee, labels, title, evidence, rank |
| `lore_work_push` | yes | write ticket state to Jira: transition linked issues, create missing ones (explicit only) |

enso-agent-bootstrap's `install.sh` does exactly this (it runs
`lore mcp --list-tools` at route time; `LORE_DENY_TOOLS` in its conf is the
deny list, default `lore_remember`). Copy `plugins/lore/skills/lore-mcp/SKILL.md`
into the workspace skills dir, and restart the agent service.

## 8. When the engagement ends

```sh
lore archive --context lore-<client>
```

Sync stops, writes are refused, reads are labelled ARCHIVED. The repo stays.

---

## Command reference (agent-facing)

| Tool / command | What it answers |
|---|---|
| `lore_recall` / `lore recall [category]` | who the client is, pins, requests, decisions, roadmap, open GitHub work, last sync |
| `lore_grep` / `lore grep <regex> [--channel x]` | where something was said — file:line hits across Slack, GitHub, meetings |
| `lore_read` / `lore read <path>` | the day file around a hit, for context and quotes |
| `lore_remember` / `lore remember "<fact>" -c <cat>` | pin a fact — only on explicit instruction |
| `lore check` (in a context repo) | config + per-source health |
| `lore run-all` (on the host) | what the timer runs |

Trust order: pins → work tables (GitHub is authoritative for delivery state) →
derived (LLM, cited) → reports → raw streams. Meetings are evidence, not decisions.

## Troubleshooting

- `✗ slack: channel #x not found or bot not a member` — `/invite @lore`, check the exact name.
- `✗ github: repo … not found or token lacks access` — add the exe.dev GitHub integration for that repo (step 2).
- `✗ granola: folder "X" not found` — match the folder title exactly, or pass the folder id.
- Notion pages missing — the integration hasn't been connected to that page (or an ancestor); Notion → page `···` → Connections.
- `✗ figma: file X: figma 403/404` — the token's account can't open that file (or the key is wrong); share the file with that account.
- `✗ jira: project X: jira 400 …` — wrong key, or the API token's account can't see that project.
- `✗ gmail: mailbox x@…: … unauthorized_client` — domain-wide delegation isn't granted for the service account (Admin console → Security → API controls), or x@… isn't a Workspace user. `gmail: no service account key` — the key JSON is missing from `~/.lore/gmail-sa.json` on the host.
- Gmail synced 0 docs on a busy client — check `client.domains`: the search is from/to/cc those domains (and client-side contacts) in each mailbox, nothing else.
- `granola: no credentials — run lore auth granola` — the token file on the host is missing; run it there.
- Sync ran but `lore recall` looks stale — reads pull the cache first; `--no-pull` skips that. The host syncs hourly; `systemctl start lore-sync.service` forces it.
- Fold warnings `⚠ requests: model omitted N existing item(s) — kept them` are normal on commit-only batches; nothing was lost.

## One-time prerequisites (already done for this workspace)

- `lore-host` VM with the timer (`deploy/exe/setup.sh`), LLM via `llm.int.exe.xyz`
- exe.dev integrations on tag `lore`: `slack` (bot token), `notion` (internal integration token, proxy to https://api.notion.com), `figma` (personal access token as X-Figma-Token, proxy to https://api.figma.com), `jira` (Basic email:token, proxy to the Atlassian site — when a client uses Jira), GitHub App connected to the org
- `lore auth granola` run once on the host
- For email: a Google Cloud service account (Gmail API enabled) with domain-wide delegation for `gmail.readonly` (plus `admin.directory.user.readonly` for `users: "all"`) granted in the Workspace Admin console, its key JSON at `~/.lore/gmail-sa.json` on the host — see `docs/DEPLOY_EXE.md`
- Laptop `~/.lore/config.json` with `remote` and `proxy` — see `docs/DEPLOY_EXE.md`
