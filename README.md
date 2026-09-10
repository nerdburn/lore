# lore

**Git-native project memory for agents.** Everything is derived from sources of truth (Slack, GitHub, Granola meetings, Notion, Jira; email planned) — except what you explicitly ask it to remember. Ask an agent literally anything about a project and it can find it.

No server, no database service. Text in git is the source of truth; a GitHub Actions cron keeps it fresh; the CLI is the interface — the repo is just the database.

## How it works

```
lore setup     # wizard: create a context repo, sync it, link this repo
lore sync      # connectors → context/streams/ + context/work/  (deterministic, no LLM)
lore extract   # streams → derived artifacts      (LLM fold — Claude API only)

lore grep      # search project memory — from any linked repo, or anywhere with -p
lore recall    # pinned facts + derived artifacts
lore remember  # pin a fact (the only explicit write)
lore mcp       # the same verbs as MCP tools over stdio, for agents
```

Two ways to host the storage — GitHub repos synced by Actions (the original
layout, below), or **self-hosted**: one VM holds every client's context repo
and a timer runs the sync; tokens live in the host platform's secret
injection, never on disk. See [docs/DEPLOY_EXE.md](docs/DEPLOY_EXE.md) for
the exe.dev runbook; `lore setup` switches modes on `remote` in
`~/.lore/config.json`, and everything else is identical.

Storage and interface are separate layers:

- **Storage** is a *context repo* — a plain private git repo, usually one per
  client, separate from the code. Slack history has a different audience than
  code, and a standalone repo has no CI or branch protection for the sync to
  fight. A daily GitHub Action keeps it fresh.
- **Interface** is this CLI. Project repos carry a one-line pointer; the CLI
  resolves it, keeps a clone in `~/.lore/cache/`, pulls before reads, pushes
  writes. Neither agents nor humans need to know where the files live.

Sync pulls raw material into `context/streams/` as permalinked markdown,
scrubbing anything that looks like a token, key, or password on the way in
(git history is forever). Sources that own delivery state — GitHub Issues —
also write a table under `context/work/` that sync overwrites and the LLM
never touches: what is open, in progress, or done comes from the tracker,
not from a model's reading of the conversation. Extract folds it into structured artifacts —
`derived/requests.yaml`, `decisions.yaml`, `roadmap.yaml`, weekly reports —
every item citing its source. `facts.yaml` is the pinned layer: written only
via `lore remember`, and it wins over derived data on conflict. Every pin
also lands in `context/audit.jsonl` with who asked, through which surface,
and the supporting source.

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

### 2b. Add GitHub and Granola (optional, per client)

Both are extra entries under `sources` in the context repo's `lore.json`,
plus a secret on the repo. Every scope belongs to exactly one client repo.

```json
"github":  { "repos": ["acme/web", "acme/mobile"], "token": "env:LORE_GITHUB_TOKEN" },
"granola": { "token": "env:GRANOLA_TOKEN", "folders": ["Acme"], "attendee_domains": ["acme.com"] }
```

- **GitHub** syncs issues, pull requests, comments, reviews, commits, and
  releases for each repo, and maintains `context/work/github/<owner>__<repo>.yaml`
  — the live issue/PR table, seeded with every open item on the first sync.
  Use a fine-grained token (or a GitHub App installation token) with read
  access to Contents, Issues, Pull requests, and Metadata on just those
  repos, and store it as `LORE_GITHUB_TOKEN`. Never a broad personal token,
  and not the workflow's own `GITHUB_TOKEN`, which only sees the context
  repo. `include` narrows the kinds (`issues`, `comments`, `reviews`,
  `commits`, `releases`); `overlap_days` defaults to 1.
- **Granola** talks to Granola's MCP server as a client, so it sees exactly
  what a Granola-connected agent sees. Auth is OAuth: run `lore auth granola`
  once on the machine that syncs — it prints a URL and a code, you approve in
  a browser, and the grant is saved to `~/.lore/granola-auth.json` and
  refreshed automatically (a static `token` or a proxy `endpoint` also work).
  Meetings are scoped by `folders` (titles or ids), `attendee_domains`, and
  the repo's `client` block — any attendee at a client domain or any listed
  client-side contact marks a meeting; the union is synced.
  Each meeting becomes a notes doc (title, attendees with emails, private
  notes, AI summary) plus a threaded transcript (`"transcripts": false` to
  skip). Meetings sync once they are `settle_hours` old (default 1) so the
  summary exists. Meeting content is evidence for extraction, never
  authoritative work or facts.

- **Notion** reads pages and databases an internal integration has been
  connected to (Notion → page ··· → Connections). Sharing is the consent
  model. Scope a client's docs with `roots` — page or database ids or URLs;
  anything beneath one is in — or leave it empty for everything shared. Each
  edit becomes a stream doc with the page rendered to markdown (title,
  database properties, blocks), so documentation history is grep-able and
  folded like everything else. Pages edited in the last `settle_minutes`
  (default 30) wait for the next run. Token as `env:NOTION_TOKEN`, or an
  `api_base` proxy that injects it.

- **Jira Cloud** syncs issues and comments per project key, rendering
  Atlassian Document Format to markdown, and maintains
  `context/work/jira/<KEY>.yaml` — the live issue table with Jira's status
  and status category (`state: open` unless the category is Done), seeded
  with every unresolved issue on the first sync. Credentials are HTTP Basic:
  `email` + `token` as env refs, or an `api_base` proxy that injects the
  header (`--header "Authorization: Basic <base64 email:token>"`). `site` is
  the Atlassian URL for permalinks.

- **Gmail** reads the client's email out of your team's inboxes — for the
  client who doesn't use Slack. One Google Workspace *service account with
  domain-wide delegation* (scope `gmail.readonly`, granted once by a
  Workspace admin) lets the connector read each teammate's mailbox without a
  per-person consent flow. Mailboxes default to the `team`-side contacts in
  the `client` block; `users` names them, or `users: "all"` reads every
  active mailbox in the Workspace (listed through the Directory API as
  `admin`, default `client.owner` — delegate
  `admin.directory.user.readonly` as well), so a teammate the client emails
  for the first time is covered with no config change. `exclude` is an
  opt-out either way. In each mailbox it searches for mail from/to/cc the
  client's domains or client-side contacts, so internal mail never matches. A thread that landed
  in four inboxes is one doc, keyed on its Message-ID (`meta.mailboxes` says
  who had it); replies chain on `References`. Quoted history and signatures
  are trimmed. The key JSON lives on the syncing host at
  `~/.lore/gmail-sa.json` (`key_file`), or as `key: env:GMAIL_SA_KEY` — a
  header-injecting proxy can't hold it, because the bearer differs per
  mailbox. Setup: `--gmail` (team contacts), `--gmail all`, or
  `--gmail "a@x.com,b@x.com"`.

```json
"gmail": { "users": "all", "admin": "shawn@inputlogic.ca", "exclude": [], "query": "-subject:\"Invitation:\" -label:newsletters" }
```

`lore setup --github "acme/web" --granola "Acme" --notion "<page url>" --jira "ACM" --jira-site https://acme.atlassian.net --gmail --client "Acme" --domains "acme.com"`
writes the sources and the client block (below). `--channels` is optional
when another source is given, so a client without Slack works.

**Who the client is.** Every context repo can carry a `client` block — name,
email domains, known contacts with `side: client|team|vendor`. Email is the
identity key; names are display. Connectors use it to scope material (Granola
matches attendees), extract uses it to tell client asks from team decisions,
and `recall` returns it so an agent knows who it is talking about.

```json
"client": {
  "name": "Acme",
  "domains": ["acme.com"],
  "contacts": [{ "name": "Priya Patel", "email": "priya@acme.com", "role": "Product owner" }]
}
```

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

Every configured source must be usable or the sync fails — a source with no
connector or an unresolved `env:` ref is an error, not a skip, so CI never
commits a partial sync as if it were complete. To keep a source configured
but skipped, set `"disabled": true` on it. Per-source health (last success,
last error) is recorded in `state.json` and printed by `lore check`.

Optional `"write": { "allow": ["shawn", "priya"] }` restricts who may
`remember`. The actor is the OS user (or `--by` on the CLI; MCP callers can
never name one). It is an honesty check, not authentication — anyone who can
push to the context repo can bypass it.

Slack sync re-reads a rolling `overlap_days` window (default 1) on every run
for late deliveries, and tracks replies per thread for `thread_window_days`
(default 30), so late replies to old threads are picked up regardless of the
overlap. Both are per-source settings under `sources.slack`.

`extract` picks its LLM backend automatically: with `ANTHROPIC_API_KEY` (or
`ANTHROPIC_AUTH_TOKEN`) set it calls the Claude API, billed per token;
otherwise it shells out to a logged-in `claude` CLI, which runs on your
Claude subscription — in CI, set a `CLAUDE_CODE_OAUTH_TOKEN` secret instead
of an API key (Max plans: `claude setup-token`). Override with
`LORE_LLM=sdk|cli`. The fold returns a delta (new or changed items only;
everything else is kept verbatim), so an incremental fold is small. A first
fold or multi-batch re-fold uses `LORE_MODEL` (default `claude-opus-4-8`);
the routine one-batch fold onto existing artifacts uses
`LORE_MODEL_INCREMENTAL` (default `claude-sonnet-5`).
`backfill` seeds the first sync N months back (per-source overrides
supported); everything after is forward-incremental.

</details>

## Using it

From a linked repo:

```sh
lore grep "black friday"                  # search everything
lore grep -i --channel acme-dev "deploy"  # case-insensitive, one channel
lore recall decisions                     # pinned facts + derived, one category
lore recall reports                       # the latest weekly reports
lore recall work                          # source-owned tables: live GitHub issues/PRs per repo
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

### Onboarding the next client

[docs/PLAYBOOK.md](docs/PLAYBOOK.md) is the step-by-step: five facts to
gather, invite the bot, one GitHub integration per repo, one `lore setup`
command, first sync, verify, point an agent at it. A self-hosted lore host
serves the same playbook plus a live status table of every client at its
HTTPS URL (`lore www`, installed by `deploy/exe/setup.sh`). The
`lore-onboard` skill in the plugin walks an agent through it: say "set up
lore for Acme".

### When an engagement ends

```sh
lore archive --context inputlogic/lore-acme     # or -p acme, or from inside the repo
lore archive --restore --context inputlogic/lore-acme
```

`archive` marks the context repo `lifecycle: archived` in `lore.json`,
commits and pushes, archives the GitHub repo (read-only, history kept, daily
cron stops), and drops the local cache clone and registry entry. From then
on `sync` and `extract` are no-ops, `remember` is refused, and every read —
CLI and MCP — is labelled ARCHIVED with the date, so an agent never presents
old history as current state. The repo is never deleted: it is the only
copy of the synced history and the pins. `--restore` reopens it. What stays
manual: unlinking any project repos, and removing @lore from the Slack
channels.

### For agents (MCP)

`lore mcp` serves the query surface over stdio: `lore_grep`, `lore_read`,
`lore_recall`, `lore_remember`. `lore_recall` returns exactly what the CLI
does — pins, every derived artifact, recent reports, and sync/extract
timestamps so an agent can say how fresh its answer is. In a linked repo
with Claude Code:

```sh
claude mcp add lore -- lore mcp
```

Any MCP client, pinned to a project:

```json
{ "mcpServers": { "lore": { "command": "lore", "args": ["mcp", "-p", "acme"] } } }
```

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
derived → reports → raw streams), when to recall versus grep, that GitHub's
work table is authoritative for delivery state and meetings are evidence
rather than decisions, to cite sources and report freshness, and to pin facts
only on explicit user instruction — plus how to connect the server when it
isn't already.

[`plugins/lore/skills/lore-onboard/SKILL.md`](plugins/lore/skills/lore-onboard/SKILL.md)
teaches the whole onboarding: check the hosting mode, run `lore setup --yes`
with flags, relay the human steps, verify with a real query before declaring
success — plus the rules an agent must not relax.

[`plugins/lore/evals/`](plugins/lore/evals/) holds behavioural evals for
the skill (answers from the work table, cites sources, never pins uninvited);
run them with `claude plugin eval ./plugins/lore` — see its README.

## Command reference

| Command | What it does |
|---|---|
| `lore setup [owner/repo] [--channels s] [--github repos] [--granola folders] [--notion roots] [--jira keys --jira-site url] [--gmail [mailboxes]] [--client n] [--domains d] [--backfill n] [--org o] [-y]` | wizard: create + scaffold + push a context repo, secret, first sync, link cwd |
| `lore link <owner/repo>` | point a project repo at its context repo (or a bare name when `remote` is configured) |
| `lore run-all --repos d --work d [--extract] [--report] [--concurrency n]` | self-hosted scheduler: sync every bare repo under a dir (n at a time, default 3), commit, push, then fold if `--extract` (from a timer on the host; a sync-only run may overlap a fold — see docs/DEPLOY_EXE.md) |
| `lore www --repos d [--port 8000]` | serve the onboarding playbook + live client status (self-hosted host page) |
| `lore refresh [--trigger] [--fold] [--force]` | pull the latest memory; `--trigger` asks the self-hosted host to sync now and waits (~1 min); `--fold` also runs the LLM fold so derived artifacts update (1–2 min more); `--force` overrides the 5-minute rate limit |
| `lore auth granola [--file p]` | OAuth device-code flow; saves a self-refreshing grant for the Granola connector |
| `lore archive [--restore] [--keep-local]` | end (or reopen) an engagement: lifecycle flag, GitHub archive, local cleanup |
| `lore grep <pattern> [-i] [--channel s] [--limit n] [--json]` | search streams + facts + derived |
| `lore recall [category] [--json]` | pinned facts + derived artifacts |
| `lore remember <fact> [-c cat] [--by who] [--source url]` | pin a fact; pushes immediately in pointer mode |
| `lore mcp` | MCP server over stdio |
| `lore sync` | pull new docs into `context/streams/` (run in the context repo; new channels backfill automatically; non-zero exit if any enabled source fails) |
| `lore extract [--report]` | LLM fold: streams → derived artifacts + weekly report (API key, or a Claude subscription via the `claude` CLI) |
| `lore init` | scaffold a context repo by hand |
| `lore check` | validate config, connectors, env refs; print per-source sync health |
| `lore manifest slack` | print the bundled Slack app manifest |

`grep`, `recall`, `remember`, `archive`, and `mcp` all take `--context <owner/repo>`,
`-p/--project <name>`, and `--no-pull`.

## Troubleshooting

- **`✗ slack: channel #x not found or bot not a member`** — the sync fails (non-zero exit, nothing committed in CI) until fixed: `/invite @lore`, or check the exact channel name in Slack (hyphens!). Other channels still synced and their cursors were kept.
- **`✗ jira: no such connector`** — a source is configured before its connector exists; remove it or set `"disabled": true`.
- **`✗ github: repo acme/x not found or token lacks access`** — the token's repository access doesn't include it, or the name is wrong. Other repos still synced.
- **`✗ granola: folder "Acme" not found`** — folder titles are matched case-insensitively against `list_meeting_folders`; pass the folder id instead if the title is ambiguous.
- **`✗ gmail: mailbox x@…: token for x@…: unauthorized_client`** — domain-wide delegation isn't granted for the service account's client id (Workspace Admin → Security → API controls → Domain-wide delegation, scope `https://www.googleapis.com/auth/gmail.readonly`), or that address isn't a user in the domain. Other mailboxes still synced.
- **`gmail: no service account key`** — put the key JSON at `~/.lore/gmail-sa.json` on the syncing host, or set `key_file` / `key: env:GMAIL_SA_KEY`.
- **`gmail: listing Workspace users as x@… failed`** — `users: "all"` needs the `https://www.googleapis.com/auth/admin.directory.user.readonly` scope in the same domain-wide delegation entry, and `admin` (default `client.owner`) must be a Workspace admin.
- **`"<user>" is not in lore.json write.allow`** — pins are restricted; run `lore remember --by <allowed-name>` or edit `write.allow`.
- **Re-backfill one channel** — delete that channel's cursor from `state.json` and `lore sync`; it refetches its backfill window and dedupes. (Channels newly added to `lore.json` backfill automatically.)
- **No "lore sync" workflow in the Actions tab** — GitHub sometimes misses workflows pushed in the repo-creating commit; `setup` nudges automatically, otherwise push any commit touching the file.
- **Scheduled syncs stopped after ~2 months of quiet** — GitHub disables cron on inactive repos; re-enable from the Actions tab.
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
scrubber, stream writing and dedup, the Slack connector against a fake Slack
API, the GitHub connector against a fake REST API, the Granola connector
against captured MCP responses, sync/check failure handling, context
resolution, archive, recall, every MCP tool over an in-memory transport,
`remember` + audit, and extract output parsing.

## Status

Connectors: Slack, GitHub and Jira (each with a source-owned work table), Granola, Notion. `extract` (requests/decisions/roadmap fold + weekly report + pin-contradiction audit), the query surface — `grep`, `recall`, `remember`, `mcp` — with pointer resolution + `~/.lore/cache`, client lifecycle (`archive`), fail-safe sync with per-source health, secret scrubbing, and an audit log. Next (see [docs/IMPLEMENTATION_BACKLOG.md](docs/IMPLEMENTATION_BACKLOG.md)): contact identity resolution, `work_tracking` modes, client-scoped MCP tools, remote MCP.

## Principles

1. Text in git is the source of truth — no binary databases in the repo; any search index is a derived, gitignored cache
2. Everything is derived unless explicitly pinned — derived data is a regenerable cache; only pins are irreplaceable
3. Sync and extraction never mix — connectors don't call LLMs; extraction doesn't call external APIs
4. Provenance is mandatory — every item links back to where it came from
5. Pointers, never credentials — the context stores "see 1Password vault X", not secrets
