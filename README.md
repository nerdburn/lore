# lore

**Git-native project memory for agents.** Everything is derived from sources of truth — Slack, GitHub, Jira, Granola meetings, Notion, and the client's email — except what you explicitly ask it to remember. Ask an agent literally anything about a project and it can find it.

No server, no database service. Text in git is the source of truth; a timer keeps it fresh; the CLI is the interface — the repo is just the database.

## How it works

```
lore setup     # wizard: create a context repo, wire every source, sync it, link this repo
lore sync      # connectors → context/streams/ + context/work/  (deterministic, no LLM)
lore extract   # streams → derived artifacts      (LLM fold — Claude API or subscription)

lore grep      # search project memory — from any linked repo, or anywhere with -p
lore recall    # pinned facts + derived artifacts + live work tables
lore remember  # pin a fact (an explicit write)
lore sow add   # attach a statement of work: human-weeks sold over a period (the other explicit write)
lore refresh   # pull the latest memory; --trigger makes the host sync right now
lore mcp       # the same verbs as MCP tools over stdio, for agents
```

Storage and interface are separate layers:

- **Storage** is a *context repo* — a plain private git repo, usually one per
  client, separate from the code. Slack history has a different audience than
  code, and a standalone repo has no CI or branch protection for the sync to
  fight.
- **Interface** is this CLI. Project repos carry a one-line pointer; the CLI
  resolves it, keeps a clone in `~/.lore/cache/`, pulls before reads, pushes
  writes. Neither agents nor humans need to know where the files live.

Two ways to host the storage, chosen once in `~/.lore/config.json` and
otherwise identical:

- **Self-hosted** (recommended): one VM holds every client's context repo as
  a bare git origin and a systemd timer runs the sync and fold every 15
  minutes. Vendor tokens live in the host platform's secret injection, never
  on disk. [docs/DEPLOY_EXE.md](docs/DEPLOY_EXE.md) is the exe.dev runbook;
  `deploy/exe/setup.sh` provisions the host.
- **GitHub-hosted**: each context repo is a private GitHub repo and a daily
  GitHub Action runs the sync, with tokens as Actions secrets.

Sync pulls raw material into `context/streams/` as permalinked markdown,
scrubbing anything that looks like a token, key, or password on the way in
(git history is forever). Sources that own delivery state — GitHub Issues,
Jira — also write a table under `context/work/` that sync overwrites and the
LLM never touches: what is open, in progress, or done comes from the
tracker, not from a model's reading of the conversation. Extract folds the
streams into structured artifacts — `derived/requests.yaml`,
`decisions.yaml`, `roadmap.yaml`, weekly reports — every item citing its
source. `facts.yaml` is the pinned layer: written only via `lore remember`,
and it wins over derived data on conflict. Every pin also lands in
`context/audit.jsonl` with who asked, through which surface, and the
supporting source.

## Setup

### 0. Install the CLI

Requires Node >= 20.12 and git; the GitHub-hosted mode also needs the
[`gh` CLI](https://cli.github.com), authenticated. Not on npm yet:

```sh
npm install -g github:nerdburn/lore
```

Self-hosted? Provision the host first ([docs/DEPLOY_EXE.md](docs/DEPLOY_EXE.md))
and set `remote` in `~/.lore/config.json` to it; `lore setup` then creates
bare repos there instead of on GitHub. GitHub-hosted? The first `lore setup`
asks which GitHub org context repos belong in (**yours, never the client's**)
and saves it.

### 1. One-time source credentials — once per workspace, not per client

Only for the sources you use. Every client after the first reuses these.

- **Slack** — `lore manifest slack | pbcopy`, then at
  [api.slack.com/apps](https://api.slack.com/apps): **Create New App → From a
  manifest** → pick the workspace → paste → **Create**, then **Install App**
  and copy the **Bot User OAuth Token** (`xoxb-…`). The app is read-only by
  design — no `chat:write`, no events; the bot never posts. `export
  SLACK_TOKEN=xoxb-…` (or `.env` — never git), or register it as the host's
  `slack` integration when self-hosted.
- **GitHub** — a fine-grained token (or a GitHub App installation) with read
  access to Contents, Issues, Pull requests, and Metadata on just the
  client's repos, as `LORE_GITHUB_TOKEN`. Never a broad personal token, and
  not an Actions workflow's own `GITHUB_TOKEN`, which only sees the context
  repo.
- **Granola** — OAuth: `lore auth granola` once on the machine that syncs. It
  prints a URL and a code, you approve in a browser, and the grant is saved
  to `~/.lore/granola-auth.json` and refreshed automatically. (A static
  `token` or a proxy `endpoint` also work.)
- **Notion** — an internal integration; its token as `NOTION_TOKEN`. Sharing
  pages with the integration (Notion → page ··· → Connections) is the consent
  model.
- **Jira Cloud** — an Atlassian account email + API token as `JIRA_EMAIL` /
  `JIRA_TOKEN` (HTTP Basic), or an `api_base` proxy that injects the header.
- **Gmail** — a Google Workspace *service account with domain-wide
  delegation*, scopes `gmail.readonly` (and `admin.directory.user.readonly`
  for `users: "all"`), granted once by a Workspace admin. Key JSON at
  `~/.lore/gmail-sa.json` on the syncing host. It can't sit behind a
  header-injecting proxy, because the bearer differs per mailbox.

### 2. Run the wizard — once per client

From inside the client's project repo:

```sh
cd ~/code/acme
lore setup --channels "#acme,#acme-dev" \
  --github "acme/web,acme/mobile" \
  --granola "Acme" \
  --notion "https://www.notion.so/acme/…" \
  --jira "ACM" --jira-site https://acme.atlassian.net \
  --gmail all \
  --client "Acme" --domains "acme.com"
```

Every flag is optional and every value is a prompt with a derived default —
the context repo name comes from the git remote (`lore-acme`), backfill
defaults to 3 months. Give it any subset of sources: `--channels` is not
required when another source is given, so a client without Slack works.
Agents and scripts pass flags plus `--yes` to skip prompts.

Setup writes `lore.json` with the sources and the client block, scaffolds
and pushes the context repo, and links the repo you're standing in. Then,
per mode: self-hosted, the host's timer picks the new repo up on its next
run; GitHub-hosted, it creates the private repo, sets the token secrets,
verifies the daily workflow registered, and dispatches the first sync.

The first sync backfills and can be slow (Slack rate-limits new apps hard;
lore waits and resumes automatically). After that, syncs are incremental.

### 3. What the human still does

- **Slack**: `/invite @lore` in each channel. The bot can only read channels
  it's been invited to — that's the consent model, not a limitation:
  `lore.json` says what lore *wants*, invitations control what it *can*, and
  the bot in the member list means a synced channel is never a secret.
- **Notion**: share the client's root page(s) with the integration.
- **GitHub**, self-hosted: one integration per client repo on the host.
- **Gmail**, first time only: a Workspace admin grants the delegation.

### 4. Link any other project repos

```sh
cd ~/code/acme-mobile
lore link your-org/lore-acme          # or just `lore link lore-acme` when self-hosted
```

Writes the one-line `lore.json` pointer and an `AGENTS.md` section — commit
both. That's the entire footprint in a code repo: no context files, no
workflow, no secrets. Any number of repos can point at one context repo.

## Sources

Each is an entry under `sources` in the context repo's `lore.json`; the
wizard writes them, and this is what they mean. Every scope belongs to
exactly one client repo. Secrets are always `env:` references (lore loads
`.env` from the working directory; real env vars win) or an `api_base` /
`endpoint` proxy that injects them, so a token never sits in git.

```json
"sources": {
  "slack":   { "channels": ["#acme", "#acme-dev"], "token": "env:SLACK_TOKEN" },
  "github":  { "repos": ["acme/web", "acme/mobile"], "token": "env:LORE_GITHUB_TOKEN" },
  "granola": { "folders": ["Acme"], "attendee_domains": ["acme.com"] },
  "notion":  { "roots": ["<page or database url>"], "token": "env:NOTION_TOKEN" },
  "jira":    { "projects": ["ACM"], "site": "https://acme.atlassian.net", "email": "env:JIRA_EMAIL", "token": "env:JIRA_TOKEN" },
  "gmail":   { "users": "all", "admin": "shawn@inputlogic.ca", "exclude": [], "query": "-subject:\"Invitation:\" -label:newsletters" }
}
```

- **Slack** syncs messages and threads per channel. Channel names must match
  Slack exactly (hyphens!). Every run re-reads a rolling `overlap_days`
  window (default 1) for late deliveries and tracks replies per thread for
  `thread_window_days` (default 30), so late replies to old threads are
  picked up regardless of the overlap. Channels added to `lore.json` later
  backfill automatically.
- **GitHub** syncs issues, pull requests, comments, reviews, commits, and
  releases for each repo, and maintains
  `context/work/github/<owner>__<repo>.yaml` — the live issue/PR table,
  seeded with every open item on the first sync. `include` narrows the kinds
  (`issues`, `comments`, `reviews`, `commits`, `releases`).
- **Granola** talks to Granola's MCP server as a client, so it sees exactly
  what a Granola-connected agent sees. Meetings are scoped by `folders`
  (titles or ids), `attendee_domains`, and the repo's `client` block — any
  attendee at a client domain or any listed client-side contact marks a
  meeting; the union is synced. Each meeting becomes a notes doc (title,
  attendees with emails, private notes, AI summary) plus a threaded
  transcript (`"transcripts": false` to skip). Meetings sync once they are
  `settle_hours` old (default 1) so the summary exists. Granola allows
  roughly one transcript fetch every two minutes per account, so a run
  syncs notes for every meeting first (cheap; the cursor advances) and then
  spends at most `transcript_seconds` (default 300) on the transcripts it
  still owes, oldest first, carrying the rest in the cursor for later runs.
  Transcript calls are paced across every client in a run, the gap widens
  each time Granola says slow down, and a transcript already in the stream
  is never fetched twice. A backfill's summaries land in the first run and
  its transcripts trickle in over the following hours. Meeting content is
  evidence for extraction, never authoritative work or facts.
- **Notion** reads pages and databases the integration has been connected to.
  Scope a client's docs with `roots` — page or database ids or URLs;
  anything beneath one is in — or leave it empty for everything shared. Each
  edit becomes a stream doc with the page rendered to markdown (title,
  database properties, blocks), so documentation history is grep-able and
  folded like everything else. Pages edited in the last `settle_minutes`
  (default 30) wait for the next run.
- **Jira Cloud** syncs issues and comments, rendering Atlassian Document
  Format to markdown, and maintains `context/work/jira/<KEY>.yaml` — the live
  issue table with Jira's status and status category (`state: open` unless
  the category is Done), seeded with every unresolved issue on the first
  sync. Scope by project keys (`projects`) or, for workspaces that run
  clients as boards inside one project, by board ids (`boards`; a board
  resolves to its saved filter's JQL — `lore setup --jira board:293`).
  `site` is the Atlassian URL for permalinks and, without a proxy, the API.
- **Gmail** reads the client's email out of your team's inboxes — for the
  client who doesn't use Slack. Mailboxes default to the `team`-side contacts
  in the `client` block; `users` names them, or `users: "all"` reads every
  active mailbox in the Workspace (listed through the Directory API as
  `admin`, default `client.owner`), so a teammate the client emails for the
  first time is covered with no config change. `exclude` is an opt-out
  either way. In each mailbox it searches for mail from/to/cc the client's
  domains or client-side contacts, so internal mail never matches. A thread
  that landed in four inboxes is one doc, keyed on its Message-ID
  (`meta.mailboxes` says who had it); replies chain on `References`. Quoted
  history and signatures are trimmed. Setup: `--gmail` (team contacts),
  `--gmail all`, or `--gmail "a@x.com,b@x.com"`.

Every configured source must be usable or the sync fails — a source with no
connector or an unresolved `env:` ref is an error, not a skip, so a scheduler
never commits a partial sync as if it were complete. To keep a source
configured but skipped, set `"disabled": true` on it. Per-source health
(last success, last error) is recorded in `state.json` and printed by
`lore check`. `backfill` seeds the first sync N months back (per-source
overrides supported); everything after is forward-incremental.

**Who the client is.** Every context repo carries a `client` block — name,
email domains, known contacts with `side: client|team|vendor`. Email is the
identity key; names are display. Connectors use it to scope material
(Granola matches attendees, Gmail matches correspondents and picks
mailboxes), extract uses it to tell client asks from team decisions, and
`recall` returns it so an agent knows who it is talking about.

```json
"client": {
  "name": "Acme",
  "domains": ["acme.com"],
  "contacts": [{ "name": "Priya Patel", "email": "priya@acme.com", "role": "Product owner" }]
}
```

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
gh secret set SLACK_TOKEN --repo your-org/lore-acme     # GitHub-hosted only
```

Optional `"write": { "allow": ["shawn", "priya"] }` restricts who may
`remember`. The actor is the OS user (or `--by` on the CLI; MCP callers can
never name one). It is an honesty check, not authentication — anyone who can
push to the context repo can bypass it.

`extract` picks its LLM backend automatically: with `ANTHROPIC_API_KEY` (or
`ANTHROPIC_AUTH_TOKEN`) set it calls the Claude API, billed per token;
otherwise it shells out to a logged-in `claude` CLI, which runs on your
Claude subscription — in CI, set a `CLAUDE_CODE_OAUTH_TOKEN` secret instead
of an API key (Max plans: `claude setup-token`). Override with
`LORE_LLM=sdk|cli`. The fold returns a delta (new or changed items only;
everything else is kept verbatim), so an incremental fold is small and
never drops an existing item. A first fold or multi-batch re-fold uses
`LORE_MODEL` (default `claude-opus-4-8`); the routine one-batch fold onto
existing artifacts uses `LORE_MODEL_INCREMENTAL` (default `claude-sonnet-5`).

</details>

## Using it

From a linked repo:

```sh
lore grep "black friday"                  # search everything
lore grep -i --channel acme-dev "deploy"  # case-insensitive, one channel
lore recall decisions                     # pinned facts + derived, one category
lore recall reports                       # the latest weekly reports
lore recall work                          # source-owned tables: live GitHub issues/PRs, Jira issues
lore remember "client wants launch before Black Friday" -c decisions
lore refresh --trigger --fold             # self-hosted: sync + fold right now, wait for it
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

`refresh` pulls what the host already has. On a self-hosted setup,
`--trigger` runs the host's sync unit over SSH and waits (about a minute);
`--fold` runs the timer's sync + LLM fold unit instead, so derived artifacts
update too. Both are rate-limited to once per 5 minutes (`--force`), and a
run already in flight is waited out rather than restarted.

### Commitments — statements of work

An SOW in lore is a *capacity commitment*: how many human-weeks were sold,
over what period, sometimes with a few named scope items. It is the one
document that is authoritative about what was agreed, so it gets its own
layer, `context/sow/<slug>.md`, written only by a human (or an agent on
explicit instruction), never by sync or the fold.

```sh
lore sow add "https://docs.google.com/document/d/…" --name "Jointly SOW 4" --weeks 12 \
  --start 2026-09-01 --signed 2026-08-28 \
  --source "https://docs.google.com/document/d/…" --scope "Agreement builder v2; Onboarding"
lore sow list
```

The document can be a **Google Doc link** — lore exports it as Markdown
through the Workspace service account (the Gmail one, with
`drive.readonly` added to its domain-wide delegation and the Drive API
enabled in its Cloud project), reading as `client.owner` or `--as
<teammate>`, so contracts never need to be link-shareable — or a Markdown,
text, or PDF file. A machine without the key hands the link to the lore host
over SSH. The body is scrubbed like every stream doc and, by
default, stripped of lines carrying currency amounts — the commitment lore
needs is in weeks, and the repo is readable by every agent pointed at it
(`--keep-commercials` to keep them). Re-adding the same name updates it;
`--status exhausted|superseded|closed` retires it. Every add commits, pushes,
and lands in the audit log.

`lore recall` (and `lore_recall`) then return a `sow` layer: each SOW's
weeks sold, effective date, status, and scope. Nothing is derived from the
calendar — the team measures a commitment by the weeks *allocated* against
it, and that will come from the scheduling source as a work table next to
this layer. The fold sees the active SOWs and notes when a request falls
outside named scope; the weekly report gets a Budget line restating the
figures. Agents
attach one with `lore_sow_add`, passing the Google Doc link (or the text
they read) plus the numbers the user or the document states.

### Onboarding the next client

[docs/PLAYBOOK.md](docs/PLAYBOOK.md) is the step-by-step: the facts to
gather, the human steps per source, one `lore setup` command, first sync,
verify, point an agent at it. A self-hosted lore host serves the same
playbook plus a live status table of every client at its HTTPS URL
(`lore www`, installed by `deploy/exe/setup.sh`). The `lore-onboard` skill
in the plugin walks an agent through it: say "set up lore for Acme".

### When an engagement ends

```sh
lore archive --context inputlogic/lore-acme     # or -p acme, or from inside the repo
lore archive --restore --context inputlogic/lore-acme
```

`archive` marks the context repo `lifecycle: archived` in `lore.json`,
commits and pushes, archives the GitHub repo when there is one (read-only,
history kept, daily cron stops), and drops the local cache clone and
registry entry. From then on `sync` and `extract` are no-ops, `remember` is
refused, and every read — CLI and MCP — is labelled ARCHIVED with the date,
so an agent never presents old history as current state. The repo is never
deleted: it is the only copy of the synced history and the pins.
`--restore` reopens it. What stays manual: unlinking any project repos, and
removing @lore from the Slack channels.

### For agents (MCP)

`lore mcp` serves the query surface over stdio: `lore_grep`, `lore_read`,
`lore_recall`, `lore_sync_now`, `lore_remember`, `lore_sow_add`. `lore_recall` returns
exactly what the CLI does — pins, every derived artifact, the work tables,
recent reports, and sync/extract timestamps so an agent can say how fresh
its answer is. `lore_sync_now` is `lore refresh`: it pulls, optionally
triggers the host's sync (and fold) and waits, and reports before/after
freshness — agents never run `lore sync` themselves. In a linked repo with
Claude Code:

```sh
claude mcp add lore -- lore mcp
```

Any MCP client, pinned to a project:

```json
{ "mcpServers": { "lore": { "command": "lore", "args": ["mcp", "-p", "acme"] } } }
```

`LORE_CONTEXT=<owner/repo or path>` in the server's environment does the same
as `--context`.

### The Claude Code plugin — skills + server in one install

This repo is a Claude Code plugin marketplace. One install gives an agent the
`lore` MCP server and the two skills that teach it to use lore well:

```
/plugin marketplace add nerdburn/lore
/plugin install lore@lore
```

(`claude plugin install lore@lore --scope project` pins it for a whole team
via `.claude/settings.json`.) The plugin lives in
[`plugins/lore/`](plugins/lore/) and needs the `lore` CLI on the PATH.

[`plugins/lore/skills/lore-mcp/SKILL.md`](plugins/lore/skills/lore-mcp/SKILL.md)
teaches an agent to *use* the memory: the trust order (pins → work tables →
derived → reports → raw streams), when to recall versus grep, that the
GitHub and Jira work tables are authoritative for delivery state and
meetings are evidence rather than decisions, when to refresh (and to fold
before answering status questions), to cite sources and report freshness,
and to pin facts only on explicit user instruction — plus how to connect
the server when it isn't already.

[`plugins/lore/skills/lore-onboard/SKILL.md`](plugins/lore/skills/lore-onboard/SKILL.md)
teaches the whole onboarding: check the hosting mode, run `lore setup --yes`
with flags, relay the human steps, verify with a real query before declaring
success — plus the rules an agent must not relax.

[`plugins/lore/evals/`](plugins/lore/evals/) holds behavioural evals for
the skill against a synthetic fixture client (answers from the work table,
cites sources, never pins uninvited); run them with
`claude plugin eval ./plugins/lore` — see its README.

## Command reference

| Command | What it does |
|---|---|
| `lore setup [owner/repo] [--channels s] [--github repos] [--granola folders] [--notion roots] [--jira keys\|board:id --jira-site url] [--gmail [mailboxes]] [--client n] [--domains d] [--backfill n] [--org o] [-y]` | wizard: create + scaffold + push a context repo, secrets (GitHub mode), first sync, link cwd |
| `lore link <owner/repo>` | point a project repo at its context repo (or a bare name when `remote` is configured) |
| `lore refresh [--trigger] [--fold] [--force]` | pull the latest memory; `--trigger` asks the self-hosted host to sync now and waits (~1 min); `--fold` also runs the LLM fold so derived artifacts update (1–2 min more); `--force` overrides the 5-minute rate limit |
| `lore auth granola [--file p]` | OAuth device-code flow; saves a self-refreshing grant for the Granola connector |
| `lore archive [--restore] [--keep-local]` | end (or reopen) an engagement: lifecycle flag, GitHub archive, local cleanup |
| `lore grep <pattern> [-i] [--channel s] [--limit n] [--json]` | search streams + facts + derived |
| `lore recall [category] [--json]` | pinned facts + derived artifacts + work tables |
| `lore remember <fact> [-c cat] [--by who] [--source url]` | pin a fact; pushes immediately in pointer mode |
| `lore sow add <file-or-gdoc-link> --name n --weeks n --start d [--end d] [--signed d] [--source url] [--scope items] [--status s] [--as email] [--by who] [--keep-commercials]` | attach a statement of work (Google Doc link, .md/.txt/.pdf): weeks sold over a period; commits + pushes |
| `lore gdoc export <url> --as <email> [--json]` | export a Google Doc as Markdown via the service account (used by `sow add` on the host) |
| `lore sow list [--json]` | attached SOWs |
| `lore mcp` | MCP server over stdio |
| `lore sync` | pull new docs into `context/streams/` (run in the context repo; new channels backfill automatically; non-zero exit if any enabled source fails) |
| `lore extract [--report]` | LLM fold: streams → derived artifacts + weekly report (API key, or a Claude subscription via the `claude` CLI) |
| `lore run-all --repos d --work d [--extract] [--report] [--concurrency n]` | self-hosted scheduler: sync every bare repo under a dir (n at a time, default 3), commit, push, then fold if `--extract` (from a timer on the host; a sync-only run may overlap a fold — see docs/DEPLOY_EXE.md) |
| `lore www --repos d [--port 8000]` | serve the onboarding playbook + live client status (self-hosted host page) |
| `lore init` | scaffold a context repo by hand |
| `lore check` | validate config, connectors, env refs; print per-source sync health |
| `lore manifest slack` | print the bundled Slack app manifest |

`grep`, `recall`, `remember`, `sow`, `refresh`, `archive`, and `mcp` all take
`--context <owner/repo>`, `-p/--project <name>`, and `--no-pull`.

## Troubleshooting

- **`✗ slack: channel #x not found or bot not a member`** — the sync fails (non-zero exit, nothing committed) until fixed: `/invite @lore`, or check the exact channel name in Slack (hyphens!). Other channels still synced and their cursors were kept.
- **`✗ <source>: no such connector`** — a source is configured that lore doesn't know; fix the key or set `"disabled": true`.
- **`✗ github: repo acme/x not found or token lacks access`** — the token's repository access doesn't include it, or the name is wrong. Other repos still synced.
- **`✗ granola: folder "Acme" not found`** — folder titles are matched case-insensitively against `list_meeting_folders`; pass the folder id instead if the title is ambiguous.
- **Notion syncs nothing for a root** — the page isn't shared with the integration yet (page ··· → Connections), the id/URL is wrong, or it was edited in the last 30 minutes and is still settling. A `notion 404` on the root means the first.
- **`✗ jira: no credentials …`** / **`jira 401`** — `email` + `token` (or the proxy's Basic header) don't resolve or don't match `site`; a board id must belong to a project the account can see.
- **`✗ gmail: mailbox x@…: token for x@…: unauthorized_client`** — domain-wide delegation isn't granted for the service account's client id (Workspace Admin → Security → API controls → Domain-wide delegation, scope `https://www.googleapis.com/auth/gmail.readonly`), or that address isn't a user in the domain. Other mailboxes still synced.
- **`gmail: no service account key`** — put the key JSON at `~/.lore/gmail-sa.json` on the syncing host, or set `key_file` / `key: env:GMAIL_SA_KEY`.
- **`gmail: listing Workspace users as x@… failed`** — `users: "all"` needs the `https://www.googleapis.com/auth/admin.directory.user.readonly` scope in the same domain-wide delegation entry, and `admin` (default `client.owner`) must be a Workspace admin.
- **`"<user>" is not in lore.json write.allow`** — pins are restricted; run `lore remember --by <allowed-name>` or edit `write.allow`.
- **`refresh: host … skipped-recent`** — the host synced (or folded) within the last 5 minutes; `--force` to run anyway.
- **Re-backfill one channel** — delete that channel's cursor from `state.json` and `lore sync`; it refetches its backfill window and dedupes. (Channels newly added to `lore.json` backfill automatically.)
- **No "lore sync" workflow in the Actions tab** (GitHub-hosted) — GitHub sometimes misses workflows pushed in the repo-creating commit; `setup` nudges automatically, otherwise push any commit touching the file.
- **Scheduled syncs stopped after ~2 months of quiet** (GitHub-hosted) — GitHub disables cron on inactive repos; re-enable from the Actions tab.
- **`could not pull … using cached copy`** — offline or no read access; queries serve the cache. Delete `~/.lore/cache/<owner>__<repo>` to force a fresh clone.
- **`remember` failed to push** — the pin is committed in the cache clone; fix access and `git -C ~/.lore/cache/<owner>__<repo> push`.

## Development

```sh
npm install
npm test          # node:test via tsx — fixtures only, no credentials needed
npm run typecheck
npm run build
```

CI (`.github/workflows/ci.yml`) runs the same three on every push and PR.
Tests cover config validation (typed per-source schemas), the secrets
scrubber, stream writing and dedup, every connector against a fake API
(Slack, GitHub, Granola via captured MCP responses, Notion, Jira, Gmail),
Granola OAuth, sync/check failure handling, context resolution, archive,
recall, every MCP tool over an in-memory transport, `remember` + audit,
extract output parsing and merging, the self-hosted runner and refresh,
statements of work (add, recall layer, MCP tool, PDF extraction), and the
`lore www` host page.

## Status

Connectors: Slack, GitHub, Jira, Granola, Notion, Gmail — GitHub and Jira
each with a source-owned work table. `extract` (delta fold into
requests/decisions/roadmap + weekly report + pin-contradiction audit), the
query surface — `grep`, `recall`, `remember`, `refresh`, `mcp` — with
pointer resolution + `~/.lore/cache`, two hosting modes (self-hosted timer
or GitHub Actions), a `lore setup` wizard covering every source, a Claude
Code plugin with skills and evals, client lifecycle (`archive`), statements of work as a human-owned
commitments layer, fail-safe sync with per-source health, secret scrubbing,
and an audit log. Next (see
[docs/IMPLEMENTATION_BACKLOG.md](docs/IMPLEMENTATION_BACKLOG.md)): contact
identity resolution, `work_tracking` modes, client-scoped MCP tools, remote
MCP.

## Principles

1. Text in git is the source of truth — no binary databases in the repo; any search index is a derived, gitignored cache
2. Everything is derived unless explicitly pinned — derived data is a regenerable cache; only pins are irreplaceable
3. Sync and extraction never mix — connectors don't call LLMs; extraction doesn't call external APIs
4. Provenance is mandatory — every item links back to where it came from
5. Pointers, never credentials — the context stores "see 1Password vault X", not secrets
