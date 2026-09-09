# Self-hosting lore on exe.dev

One VM owns every client's context repo and runs the sync on a timer. No
GitHub Actions, no per-repo secrets: vendor tokens live in exe.dev
integrations and are injected at the network edge, so they never exist on
the VM's disk.

```
laptop / agent ── ssh clone/pull/push ──▶  VM  /srv/lore/repos/<client>.git   (bare, the origin)
                                            │   /srv/lore/work/<client>       (clone the timer syncs in)
                                            │   systemd: lore-sync.timer → lore run-all (hourly)
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

`setup.sh` installs Node 22 and lore, creates `/srv/lore/{repos,work}`, and
enables `lore-sync.timer` (hourly, `INTERVAL=30m` to change). Re-run it to
upgrade lore. Logs: `ssh lore-host.exe.xyz journalctl -u lore-sync -f`.

## 2. Secrets as integrations

Create once, attach to the `lore` tag so every future lore VM gets them:

```sh
ssh exe.dev integrations add http-proxy --name slack --target https://slack.com --bearer xoxb-… --attach tag:lore
ssh exe.dev integrations add github --name lore-acme-web --repository acme/web --readonly --attach tag:lore   # per client repo
```

Granola is the exception: its MCP server uses OAuth with short-lived access
tokens, which a header-injecting proxy can't refresh. Authorise it once on
the VM as the runner user — the grant (with refresh token) lives in the
runner's home and refreshes in place:

```sh
ssh exedev@lore-host.exe.xyz lore auth granola     # prints a URL + code; approve in a browser
```

Inside the VM these become `https://slack.int.exe.xyz/api` and — for every GitHub repo integration
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
    "github":  "https://github.int.exe.xyz/api/v3"
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

## 6. Archive, backup, access

- `lore archive --context lore-acme` flips the lifecycle; `run-all` skips it.
  The bare repo stays.
- Backup: the VM disk is the only copy. `ssh exe.dev cp lore lore-backup`
  clones the VM; or mirror `/srv/lore/repos/*.git` nightly to a private
  GitHub org through the GitHub integration.
- Access = SSH access to the VM (`ssh exe.dev share`, or team membership).
  Per-client read scoping is the remote-MCP milestone, not this layer.
