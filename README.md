# Lore

Lore is a Model Context Protocol (MCP) server that gives an agent memory for a client project. Ask “What are we already working on, who asked for it, and where did we agree to it?” The agent can search conversations, meetings, docs and tickets, follow links to the original evidence, and update tracked work when asked.

Each project has a private Git repository, called its **context repo**, separate from the code repos it tracks. **Sync** imports source material. Optional **extraction** turns it into requests, decisions, roadmap entries and reports. An optional **web board** lets people manage tickets, triage requests and edit project goals. If your team already hosts Lore, skip to [Connect an MCP client](#connect-an-mcp-client).

## Install Lore

On the machine where you will set up projects, use Git, npm and Node.js 22.13+ (22.x) or Node 24. Build and install the CLI from this repository.

```sh
git clone https://github.com/nerdburn/lore.git
cd lore
npm ci
package=$(npm pack --ignore-scripts --silent)
npm install -g "./$package"
lore --version
```

`npm ci` builds the CLI and the web UI. Keep the tarball if you plan to install the same build on a server.

## Choose where project memory lives

**For one person, start locally.** Create a directory for your private context repos, such as `mkdir -p "$HOME/lore-data/repos"`. Set `remote` in `~/.lore/config.json` to that directory’s **absolute path**. Create `~/.lore` and the config file if needed. For example, on a Mac the setting might be `{ "remote": "/Users/alex/lore-data/repos" }`. You run sync locally and your MCP client starts Lore over stdio.

**For a team, deploy one shared host.** The included provisioning script targets an exe.dev Linux VM. It installs Lore, creates the Git storage under `/srv/lore/repos`, starts the HTTP service on port 8000, and schedules sync every 15 minutes by default. Run these commands from the Lore checkout with your own VM name and the tarball built above.

```sh
ssh exe.dev new --name acme-lore --cpu 1 --memory 2GB --disk 30GB --tag lore
host=exedev@acme-lore.exe.xyz
scp deploy/exe/setup.sh "$host:/tmp/lore-setup.sh"
scp "$package" "$host:/tmp/lore.tgz"
ssh "$host" 'sudo env LORE_REF=/tmp/lore.tgz bash /tmp/lore-setup.sh'
ssh "$host" 'systemctl is-active lore-sync.timer lore-www.service'
```

On your laptop, set the following field in `~/.lore/config.json`. Lore uses SSH to create, clone and update context repos on this host.

```json
{ "remote": "exedev@acme-lore.exe.xyz:/srv/lore/repos" }
```

Keep the host private while setting it up. The host trusts exe.dev’s authenticated peer identity for VM agents, so the raw service port must only be reachable through a trusted ingress. Back up the context repos and the credentials needed to restore service. [Host deployment, authentication and backups](docs/DEPLOY_EXE.md)

## Create a project and run the first sync

1. **Authorize a source.** For this example, give a GitHub token read access to the selected repository’s contents, issues, pull requests and metadata. Set `LORE_GITHUB_TOKEN` in the environment of the process that runs sync. Locally, that is your shell. On the VM, edit `/etc/lore/env` with `sudoedit`, or use a credential-injecting integration. Keep credential values outside the context repo.
2. **Create the context.** Run setup from the project’s code repo. Replace the sample repo, name and addresses with your own.

   ```sh
   cd ~/code/acme-web
   lore setup lore-acme --client "Acme" --owner pm@example.com \
     --domains acme.example --github your-org/acme-web --yes
   ```

   This creates `lore-acme` in the configured storage. In a Git checkout without an existing `lore.json`, setup also writes a pointer and an `AGENTS.md` entry. Commit those two files so teammates inherit the link. In another code repo for the same project, run `lore link lore-acme` to share that memory.
3. **Sync.** On a local installation, run the following with the repos path you configured above.

   ```sh
   lore run-all --repos "$HOME/lore-data/repos" --work "$HOME/lore-data/work"
   ```

   On the shared host, the timer discovers new projects automatically. To start immediately, run `ssh "$host" 'sudo systemctl start lore-sync.service'`. The first run backfills three months by default. Set `--backfill` during setup to change the window. Repeat the local command when you want fresh data, or schedule it.
4. **Verify from the linked code repo.** Run `lore source list` to see each source’s scope, last success and errors. Run `lore grep "checkout"` with a term you expect to find. A successful sync makes the raw material searchable even before extraction.

For derived requests, decisions and reports, set `ANTHROPIC_API_KEY` for the runner and add `--extract` to local `run-all`, or set `LORE_EXTRACT=1` in the host’s `/etc/lore/env`. For Jev’s semantic matching, including linking requests to work that already covers them, also set `TYPESAFE_API_KEY`. These features send relevant project material to their configured model providers. [Extraction options](docs/DEPLOY_EXE.md#5-extract)

## Connect an MCP client

**Local or SSH-backed Git storage.** Configure your MCP client to launch `lore mcp --context lore-acme`. The machine running the client needs the CLI, the `remote` setting and access to the context repo. For Codex, register the server once.

```sh
codex mcp add lore-acme -- lore mcp --context lore-acme
```

For a client with a JSON configuration file, add this server entry.

```json
{
  "mcpServers": {
    "lore-acme": {
      "command": "lore",
      "args": ["mcp", "--context", "lore-acme"]
    }
  }
}
```

**Hosted HTTP.** A client can instead connect to `https://YOUR-LORE-HOST/mcp/lore-acme`. For a person signing in from a laptop, enable the web board and grant that person project access as described below. In Claude Code, register the URL with this command.

```sh
claude mcp add --transport http lore-acme https://YOUR-LORE-HOST/mcp/lore-acme
```

Open `/mcp`, select the server and authenticate in the browser. For an agent on another exe.dev VM, create a peer integration and grant its VM access to one project. These commands assume an agent VM named `acme-agent`.

```sh
ssh exe.dev integrations add http-proxy --name lore-mcp --target https://acme-lore.exe.xyz/ --peer --attach vm:acme-agent
ssh "$host" lore agents allow acme-agent lore-acme
```

Configure that agent’s HTTP MCP client with `https://lore-mcp.int.exe.xyz/mcp/lore-acme`. Peer access works with the web board switched off. [Peer-agent setup](docs/DEPLOY_EXE.md#6-giving-another-vms-agent-access--the-hosted-mcp-endpoint) · [Laptop OAuth](docs/DEPLOY_EXE.md#10-mcp-from-laptops--oauth)

To check the connection, ask your agent **“Use Lore to list the sources for Acme and tell me when they last synced.”** Then try **“Which requests are already covered by open tickets? Show me the evidence.”** Run `lore mcp --list-tools` to see the full tool list and which tools write to project memory.

## Link more sources

From a linked code repo, `lore source add` adds a source or widens its scope. From elsewhere, append `--context lore-acme`. The next sync imports the new scope using the runner’s credentials.

```sh
lore source add github your-org/acme-mobile
lore source add granola "Acme planning"
lore source list
```

| Source | Project scope | Access needed by the sync runner |
| --- | --- | --- |
| Slack | `--channels "#acme"` at setup, or `lore source add slack "#acme"` | Create a Slack app from the manifest printed by `lore manifest slack`, install it, invite its bot to each channel, and configure `SLACK_TOKEN` or a Slack proxy. |
| GitHub | `--github owner/repo`, or `lore source add github owner/repo` | Repo access via `LORE_GITHUB_TOKEN` or an integration for the selected repos. Imports issues, pull requests, reviews, comments, commits and releases. |
| GitHub Projects v2 | Project owner, number, and a mapping from project columns to Lore statuses | Configure `sources.github_projects` in the **context repo’s** `lore.json` and push the change. Grant Projects access, including write access for two-way updates. [Configuration example](docs/GITHUB_PROJECTS_SOURCE.md) |
| Jira Cloud | `lore source add jira ACM --site https://acme.atlassian.net` or use `board:123` | `JIRA_EMAIL` and `JIRA_TOKEN`, or an authenticated proxy with access to the project. |
| Linear | `lore source add linear ENG` after setup | A workspace key with access to that team. Hosted setups using proxies pass the client’s GraphQL `--api-base` and attachment `--uploads-base`. Direct-token configs use `LINEAR_API_KEY`. |
| Granola | `lore source add granola "Acme planning"` | Run `lore auth granola` as the sync user on the syncing machine, or configure an authenticated endpoint. |
| Notion | `lore source add notion <page-or-database-url>` | Share each root with the integration and configure `NOTION_TOKEN` or a proxy. |
| Figma | `lore source add figma <file-url-or-key>` | Give the token’s account access to the design file, FigJam board or Slides deck. Configure `FIGMA_TOKEN` or a proxy. |
| Gmail | `lore source add gmail pm@example.com` | Configure client domains or contacts and a Workspace service account with admin-approved domain-wide delegation for Gmail read access. Start with named team mailboxes. [Gmail setup](docs/PLAYBOOK.md#3d-gmail--for-the-client-who-doesnt-use-slack) |

With a configured `remote`, adding a **new** Slack, GitHub, Notion, Jira or Figma source through `source add` requires the corresponding `proxy` entry in `~/.lore/config.json`. With direct tokens, include the source in `lore setup` or edit the context repo’s `lore.json` and commit and push it. For example, a new Slack block under `sources` can be `"slack": { "channels": ["#acme"], "token": "env:SLACK_TOKEN" }`. The token value belongs on the runner. [Proxy configuration](docs/DEPLOY_EXE.md#3-laptop-config)

For GitHub Projects, merge the following example into the context repo’s `sources` object. Use the owner, project number and column names from your own board, then commit and push.

```json
{
  "github_projects": [{
    "owner": "your-org",
    "number": 7,
    "status_field": "Status",
    "status_map": { "Todo": "todo", "In Progress": "in_progress", "Done": "done" }
  }]
}
```

**Documents are a separate import.** Use `lore doc add ./brief.pdf` for a client file, or pass a Google Drive file or folder URL with Drive access configured. Lore also reads local Markdown, text, CSV, Word, Excel and PowerPoint files. Use `lore sow add` for a statement of work that should inform planning. [Onboarding playbook](docs/PLAYBOOK.md)

## Enable the optional web board

The shared host can serve a board for project members and read-only viewers at `/board/`. It includes kanban and list views, request intake, and a Goals page for the account team.

1. On the host, set `LORE_BOARD=1` and `LORE_BOARD_ADMINS` in `/etc/lore/env`. Configure `LORE_BOARD_EMAIL_FROM` with a verified sender and either `RESEND_API_KEY` or `LORE_BOARD_EMAIL_API` for emailed sign-in codes. Restart with `sudo systemctl restart lore-www`.
2. From the linked code repo, enable this project and grant access.

   ```sh
   lore board enable
   lore board add pm@example.com
   lore board add reviewer@acme.example --viewer
   ```

3. Open `https://YOUR-LORE-HOST/board/p/lore-acme` and sign in with an allowed email. For access outside your private network, configure the host’s HTTPS ingress before sharing the link. [Web board deployment](docs/DEPLOY_EXE.md#8-the-web-board)

## Other ways to run Lore

- **GitHub Actions storage.** With no `remote` configured, authenticate the GitHub CLI and use `lore setup your-org/lore-acme --github your-org/acme-web --client Acme`. Setup creates a private context repo and scaffolds a daily workflow. In that repo’s `.github/workflows/lore-sync.yml`, replace the Extract step’s direct secret check with `if: vars.LORE_EXTRACT == '1'`. Set the Actions variable `LORE_EXTRACT` to `1` and supply a model credential if you want extraction. Expose each connector’s required secrets to the Sync step, then run **Actions → lore sync → Run workflow** to verify. Connect a local MCP client with `--context your-org/lore-acme`. [Bundled workflow](manifests/lore-sync.yml) · [GitHub Actions secret handling](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets#using-secrets-in-a-workflow)
- **Claude Code plugin.** With the Lore CLI on your path, run `/plugin marketplace add nerdburn/lore` and then `/plugin install lore@lore` in Claude Code to install its MCP configuration and project-memory skills. [Plugin](plugins/lore/)
- **Development.** From this checkout run `npm test`, `npm run typecheck` and `npm run build:web`. The CLI and server live in `src/`. The React board lives in `web/`. [Roadmap and goals](docs/ROADMAP_GOALS.md) · [Project activity reports](docs/LOAD.md)
