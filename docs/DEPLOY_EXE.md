# Self-hosting lore on exe.dev

One VM owns every client's context repo and runs the sync on a timer. No
GitHub Actions, no per-repo secrets: vendor tokens live in exe.dev
integrations and are injected at the network edge, so they never exist on
the VM's disk.

```
laptop / agent ── ssh clone/pull/push ──▶  VM  /srv/lore/repos/<client>.git   (bare, the origin)
                                            │   /srv/lore/work/<client>       (clone the timer syncs in)
                                            │   systemd: lore-sync.timer → lore run-all (every 15m)
                                            └── https://slack.int.exe.xyz, github.int…, granola.int…  (tokens injected)
```

## 1. VM

```sh
ssh exe.dev new --name lore-host --cpu 1 --memory 2GB --disk 30GB --tag lore
npm pack                                   # builds dist/ and produces nerdburn-lore-<version>.tgz
scp deploy/exe/setup.sh nerdburn-lore-*.tgz exedev@lore-host.exe.xyz:/tmp/
ssh exedev@lore-host.exe.xyz sudo LORE_REF=/tmp/nerdburn-lore-0.3.0.tgz bash /tmp/setup.sh
```

(`LORE_REF` defaults to `github:nerdburn/lore`, which builds on the VM and
needs the dev toolchain there; the tarball path needs nothing but Node.)

`setup.sh` installs Node 22 and lore, creates `/srv/lore/{repos,work}`,
enables `lore-sync.timer` (every 15 minutes; `INTERVAL=1h` to change), and starts
`lore-www.service` on the exe.dev proxy port, so `https://lore-host.exe.xyz`
shows the onboarding playbook and a live client status table (private to the
account; `ssh exe.dev share` to open it to others — with the web board on,
the proxy is public and these pages need an admin sign-in, see §8). Re-run it to
upgrade lore. Logs: `ssh lore-host.exe.xyz journalctl -u lore-sync -f`.

## 2. Secrets as integrations

Create once, attach to the `lore` tag so every future lore VM gets them:

```sh
ssh exe.dev integrations add http-proxy --name slack  --target https://slack.com      --bearer xoxb-… --attach tag:lore
ssh exe.dev integrations add http-proxy --name notion --target https://api.notion.com --bearer ntn_…  --attach tag:lore
ssh exe.dev integrations add http-proxy --name figma  --target https://api.figma.com  --header "X-Figma-Token:figd_…" --attach tag:lore
ssh exe.dev integrations add http-proxy --name jira   --target https://<site>.atlassian.net \
    --header "Authorization: Basic $(printf '%s:%s' you@company.com ATLASSIAN_API_TOKEN | base64)" --attach tag:lore
ssh exe.dev integrations add github --name lore-acme-web --repository acme/web --readonly --attach tag:lore   # per client repo
```

Granola is the exception: its MCP server uses OAuth with short-lived access
tokens, which a header-injecting proxy can't refresh. Authorise it once on
the VM as the runner user — the grant (with refresh token) lives in the
runner's home and refreshes in place:

```sh
ssh exedev@lore-host.exe.xyz lore auth granola     # prints a URL + code; approve in a browser
```

Gmail is the other exception: the connector mints a token *per mailbox* from
a service account key, so the key lives on the VM too. One-time setup, done
by a Google Workspace super-admin:

1. Google Cloud console → a project (e.g. `lore-sync`) → enable the **Gmail
   API** → IAM → Service accounts → create one (`lore`) → Keys → add a JSON
   key. Note the account's **Unique ID** (the numeric client id).
2. Workspace Admin console → Security → Access and data control → API
   controls → **Domain-wide delegation** → Add new: that client id, scope
   `https://www.googleapis.com/auth/gmail.readonly`. To let a client's
   `users: "all"` discover mailboxes, add a second scope on the same entry
   (comma-separated): `https://www.googleapis.com/auth/admin.directory.user.readonly`.
   Nothing else — no Admin SDK write scopes.
3. Copy the key to the runner's home, readable only by it:

```sh
scp lore-sync-abc123.json exedev@lore-host.exe.xyz:/home/exedev/.lore/gmail-sa.json
ssh exedev@lore-host.exe.xyz chmod 600 /home/exedev/.lore/gmail-sa.json
```

The account can read every mailbox in the domain, so tell the team, and let
lore's scoping do the limiting: per client it only searches for mail
from/to/cc that client's domains and contacts, in the mailboxes the client's
`lore.json` names.

Inside the VM these become `https://slack.int.exe.xyz/api`, `https://notion.int.exe.xyz/v1`, `https://figma.int.exe.xyz/v1`, `https://jira.int.exe.xyz/rest/api/3`, and — for every GitHub repo integration
together — `https://github.int.exe.xyz/api/v3` (GitHub Enterprise-style REST
layout; git and `gh` work against the same host). The GitHub integrations use
exe.dev's GitHub App: connect your account once at exe.dev/integrations, install
the app on the org, then one read-only integration per client repo. No personal
token anywhere; the app's 12,500 req/h limit applies. A fine-grained PAT behind
an http-proxy to `https://api.github.com` also works, but only if the org has
fine-grained tokens enabled and the token's resource owner is the org.

## 3. Laptop config

`~/.lore/config.json`:

```json
{
  "remote": "exedev@lore-host.exe.xyz:/srv/lore/repos",
  "proxy": {
    "slack":   "https://slack.int.exe.xyz/api",
    "github":  "https://github.int.exe.xyz/api/v3",
    "notion":  "https://notion.int.exe.xyz/v1",
    "figma":   "https://figma.int.exe.xyz/v1",
    "jira":    "https://jira.int.exe.xyz/rest/api/3"
  }
}
```

`remote` makes bare names resolve: a project repo's `lore.json` pointer is
`{ "context": "lore-acme" }`, and `lore grep -p acme` clones over SSH into
`~/.lore/cache/`. `proxy` is what `lore setup` writes into new repos as
`api_base`/`endpoint` instead of `env:` tokens.

## 4. Onboard a client

```sh
cd ~/code/acme
lore setup --channels "#acme,#acme-dev" --github "acme/web" --client "Acme" --domains "acme.com" --backfill 3 --yes
```

Then add `"granola": { "folders": ["Acme"] }` under `sources` in the new
repo's `lore.json` (the client block's domains scope meetings too), commit,
push.

Creates `/srv/lore/repos/lore-acme.git` over SSH, scaffolds (no workflow
file), pushes, links the repo you're in. The next timer run syncs it.
`/invite @lore` in the channels remains human.

## 5. Extract

`run-all` only extracts when `LORE_EXTRACT=1` in `/etc/lore/env`, and needs
one of: `ANTHROPIC_API_KEY`; `ANTHROPIC_BASE_URL=https://llm.int.exe.xyz`
plus any placeholder `ANTHROPIC_API_KEY` (exe.dev's default LLM integration
speaks the Anthropic Messages API and holds the key off-VM — verified with
`claude-opus-4-8`); or `CLAUDE_CODE_OAUTH_TOKEN` for the subscription
backend via the preinstalled `claude` CLI.

The fold is a delta — the model returns only new or changed items, and the
runner keeps everything else — so each timer fold costs what happened since
the last one, not the size of the project's memory. A run with no new
material makes no LLM call, which is what makes a 15-minute timer cheap. Two models: `LORE_MODEL`
(default `claude-opus-4-8`) for a first fold or a multi-batch re-fold, and
`LORE_MODEL_INCREMENTAL` (default `claude-sonnet-5`) for the routine one-batch
delta. Set both to the same id to use one model everywhere. Check the
incremental model is reachable through the LLM integration before relying on
it: `journalctl -u lore-sync` shows `[sdk:<model>]` on the extracting line.

**Fold gate.** With `TYPESAFE_API_KEY` in `/etc/lore/env`, each routine
incremental fold is preceded by one call to TypeSafe's Jev: a few calibrated
yes/no questions over only the newly appended material (does anyone ask,
decide, plan, report progress, or contradict a pin?). If none reaches
`LORE_GATE_THRESHOLD` (default 0.3) the fold is skipped and the material
marked consumed — `gate: nothing to fold … [jev]` in the journal. Backfills,
re-folds, `--review`, attached documents and first folds always fold, and any
gate error folds. Skipped material is still in the streams (grep, the weekly
report); only derived artifacts and fold ticket moves depend on the fold.
`LORE_GATE=off` disables it. Measure a threshold per client before trusting
it: `lore gate replay --since "2 weeks ago"` in a work clone replays the gate
over past sync commits and reports, per threshold, folds skipped and folds
that would have lost a change. The gate sends client material to TypeSafe as
well as the LLM provider.

## 5a. What runs when

| Unit | Started by | Does | Typical time |
|---|---|---|---|
| `lore-sync.service` | `lore-sync.timer`, every 15 min; `lore refresh --trigger --fold`, `lore_sync_now` with `fold: true` | every client: sync → commit → push → fold → commit → push | a minute or two for a routine delta; longer for a backfill |
| `lore-sync-now.service` | `lore refresh --trigger`, `lore_sync_now` | every client: sync → commit → push. Never folds | under a minute |

Both run `lore run-all` on the same work clones and may overlap: per-client
locks under `/srv/lore/work/.locks/` serialise syncs and git operations, and
a sync-only run that arrives mid-fold syncs around it (no reset, its own
half of `state.json`). An extracting run that finds a fold already in
flight skips its own fold.

A client whose sources partly failed is **degraded**, not failed: what
synced is committed and folded, the run exits 0, and the journal line reads
`! lore-acme: degraded (sources failed: github)`. The failed source keeps
its cursor and catches up on a later run. A client only *fails* when
something structural breaks (clone, push, invalid config) or every one of
its sources fails at once — so a red timer means "nothing got through",
not "one vendor was flaky". To see what is behind without reading the
journal: the host page's client table flags stale sources per client, and
`lore source list -p <client>` or `lore check` says it on the command line. Agent refreshes are rate-limited to one per 5
minutes per kind (sync, fold) unless forced. Raw streams therefore reach the bare repo within
a minute of any run starting; derived artifacts follow when the fold lands,
so `recall` can show `lastExtract` behind `lastSync`. Clients are processed
`LORE_CONCURRENCY` (default 3) at a time; journal lines are prefixed
`[lore-<client>]`.

## 6. Giving another VM's agent access — the hosted MCP endpoint

The host serves MCP itself: `lore www` answers `/mcp/<context>` on the same
port as the status page (exe.dev proxies one port per VM). An agent on another
exe.dev VM needs no lore install, no clone, no SSH key — it talks HTTP to the
host through a **VM-to-VM (peer) integration**, and the platform stamps every
request with `X-Exedev-Source-Vm: <calling vm>` after stripping anything the
caller sent. That header is the agent's identity; nothing else is trusted.

```
agent VM ── https://lore-mcp.int.exe.xyz/mcp/lore-acme ──▶ exe.dev edge (adds peer key,
                                                          sets X-Exedev-Source-Vm)
                                                          ──▶ lore-host:8000  lore www
                                                              agents.json says who may open what
                                                              ~/.lore/cache/<context> clone ⇄ /srv/lore/repos
```

One-time, per host — the integration, attached to every VM that should reach it:

```sh
ssh exe.dev integrations add http-proxy --name lore-mcp --target https://lore-host.exe.xyz/ --peer \
    --attach vm:accord-agent --attach vm:claire-agent      # repeat --attach per agent VM
ssh exe.dev integrations attach lore-mcp vm:new-agent      # later additions
```

Per agent, on the host — say which context(s) the VM may open (the file is
`~/.lore/agents.json`; the server reads it on every new session, no restart):

```sh
ssh exedev@lore-host.exe.xyz lore agents allow accord-agent lore-jointly
ssh exedev@lore-host.exe.xyz lore agents allow ops-agent '*' --as ops   # every context; writes signed "ops"
ssh exedev@lore-host.exe.xyz lore agents list
```

Then the agent's MCP config is one line, no env, no paths:

```json
"lore": { "type": "http", "url": "https://lore-mcp.int.exe.xyz/mcp/lore-acme" }
```

Allow the `mcp__lore__*` tools in the agent's permission rules (the names are
unchanged from the stdio server; `lore mcp --list-tools` on the host prints
them) and give it the `lore-mcp` skill from `plugins/lore/skills/`.

What you get over the old per-VM install: one deploy (upgrade the host, every
agent has the new tools), real per-client scoping (a VM not granted a context
gets 403 before anything is cloned), and writes attributed to the agent —
`authorized_by: accord-agent` instead of the host's service user. A request
with no identity header (a human on the private HTTPS URL, or anything that
did not come through the edge) is refused with 401. `/mcp-sessions.json`
lists the open sessions.

Trade-off to know: the host is now in the agents' request path. If it is
down, agents have no memory until it is back (the old stdio install served a
stale cache). Keep the laptop path (`lore mcp`, stdio, a clone) for yourself;
it is unchanged.

**Upgrading agents from the stdio install:** change the `lore` entry in the
policy's `claude/mcp.json` to the http form above, restart enso. The old
install and `~/.lore/cache` on the agent VM can stay or go; nothing reads
them once the config changes.

## 7. Archive, backup, access

- `lore archive --context lore-acme` flips the lifecycle; `run-all` skips it.
  The bare repo stays.
- Backup: the VM disk is the only copy. `ssh exe.dev cp lore lore-backup`
  clones the VM; or mirror `/srv/lore/repos/*.git` nightly to a private
  GitHub org through the GitHub integration.
- Access = SSH access to the VM (`ssh exe.dev share`, or team membership).
  Per-client read scoping is the remote-MCP milestone, not this layer.

## 8. The web board

`lore www` can serve a list + kanban view of each project's tracker at
`/board`, for your team and the client's people. It is off twice over: per
host (`LORE_BOARD=1`) and per project (`lore board enable`).

**Turning it on makes the host public.** Clients have no exe.dev account, so
the proxy has to be opened (`ssh exe.dev share` → public). With the board
on, everything that used to rely on the proxy being private is gated
instead: `/`, `/status.json` and `/mcp-sessions.json` need a signed-in host
admin (others are sent to `/board`). `/mcp/<context>` is unchanged — its
identity is the `X-Exedev-Source-Vm` header the edge sets on peer requests,
and it refuses anything without one. Verify that after going public:
`curl -si https://lore-host.exe.xyz/mcp/lore-acme -H 'x-exedev-source-vm: x'`
must be a 401 (the edge strips the header from outside callers).

**Email.** Sign-in is an emailed 6-digit code, sent through Resend. The key
lives in an integration, never on the VM:

```sh
ssh exe.dev integrations add http-proxy --name resend --target https://api.resend.com \
    --bearer re_… --attach vm:lore-host
```

Verify the sending domain in Resend first. Then in `/etc/lore/env`:

```sh
LORE_BOARD=1
LORE_BOARD_ADMINS=shawn@inputlogic.ca            # members of every enabled board + the host pages
LORE_BOARD_EMAIL_FROM="Lore <lore@inputlogic.ca>"
LORE_BOARD_EMAIL_API=https://resend.int.exe.xyz
```

`sudo systemctl restart lore-www`. Sessions are signed with a key generated
once into `~/.lore/board-secret` (or `LORE_BOARD_SECRET`); a session lasts
90 days and renews as it is used. `LORE_BOARD_SESSION_EPOCH=<new value>` +
restart signs everyone out.

**Per project** (on the host or from a laptop — it is a lore.json commit):

```sh
lore board enable --context lore-acme
lore board add priya@acme.com --context lore-acme          # member
lore board add @acme.com --viewer --context lore-acme      # the whole domain, read-only
```

Access is read from lore.json at HEAD on every request, so adding or
removing someone takes effect at once, with no restart. A disabled board
has no web view for anyone, admins included. An archived client's board
is read-only.

What a board write does: the same `lore work` call the CLI makes — history
entry (`via: web`, `by: <email>`), audit line, commit, push — queued behind
any MCP write on the same context, since both use the host's one cache
clone. Codes are rate-limited per address and per IP; asking for a code for
an address with no access sends nothing and answers the same as one that
has access.

## 9. Attachments — the asset store (R2)

Files on tickets never go in git: `context/attachments.yaml` records them,
the bytes live in Cloudflare R2, and the host keeps a cache under
`~/.lore/assets`. Everything is fetched through lore (the board checks who
is asking); nothing is a public URL. Until R2 is set up, the host cache is
the only copy — set it up before relying on attachments.

One-time, from a laptop logged in to Cloudflare (`npx wrangler login`):

```sh
cd deploy/r2-worker
npx wrangler r2 bucket create lore-assets
npx wrangler deploy                                  # prints https://lore-assets.<you>.workers.dev
openssl rand -base64 32 | tee /dev/stderr | npx wrangler secret put LORE_ASSETS_SECRET
ssh exe.dev integrations add http-proxy --name lore-assets --target https://lore-assets.<you>.workers.dev \
    --bearer '<that secret>' --attach vm:lore-host
```

Then in `/etc/lore/env`: `LORE_ASSETS_API=https://lore-assets.int.exe.xyz`,
and `sudo systemctl restart lore-www`. The Worker refuses a PUT whose bytes
don't hash to the name, and the host verifies what it reads back, so the
store can only ever hold what the records say.

**Linear** (for clients who use it) needs two integrations, since uploads
live on their own host:

```sh
ssh exe.dev integrations add http-proxy --name linear         --target https://api.linear.app     --header "Authorization:lin_api_…" --attach tag:lore
ssh exe.dev integrations add http-proxy --name linear-uploads --target https://uploads.linear.app --header "Authorization:lin_api_…" --attach tag:lore
```

and in the client's `lore.json`:
`"linear": { "teams": ["PRP"], "api_base": "https://linear.int.exe.xyz/graphql", "uploads_base": "https://linear-uploads.int.exe.xyz" }`.
