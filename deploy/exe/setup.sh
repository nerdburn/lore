#!/usr/bin/env bash
# Provision an exe.dev VM as the lore host: Node 22, the lore CLI, the repo
# layout under /srv/lore, and a systemd timer that runs `lore run-all`.
# Idempotent — re-run to upgrade lore or repair units.
#
#   scp deploy/exe/setup.sh <vm>:/tmp/ && ssh <vm> sudo bash /tmp/setup.sh
#
# LORE_REF picks what to install (default github:nerdburn/lore, which builds
# on the VM and needs the dev toolchain there). A prebuilt tarball is faster
# and needs no toolchain — this is what the runbook uses:
#   npm pack && scp nerdburn-lore-*.tgz <vm>:/tmp/lore.tgz
#   ssh <vm> sudo LORE_REF=/tmp/lore.tgz bash /tmp/setup.sh
#
# Layout:
#   /srv/lore/repos/<name>.git   bare context repos (what laptops clone)
#   /srv/lore/work/<name>        working clones the timer syncs in
#   /etc/lore/env                environment for the timer (LLM creds, tokens
#                                not covered by exe.dev integrations)
set -euo pipefail

LORE_USER="${LORE_USER:-exedev}"
LORE_REF="${LORE_REF:-github:nerdburn/lore}"
INTERVAL="${INTERVAL:-15m}"

if [ "$(id -u)" -ne 0 ]; then echo "run as root (sudo)"; exit 1; fi
id "$LORE_USER" >/dev/null 2>&1 || { echo "user $LORE_USER not found"; exit 1; }

# --- Node 22 (the image ships without Node) ---
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y git >/dev/null

# --- lore CLI ---
npm install -g "$LORE_REF" >/dev/null
echo "lore $(lore --version) installed"

# --- layout ---
install -d -o "$LORE_USER" -g "$LORE_USER" /srv/lore /srv/lore/repos /srv/lore/work
install -d -m 750 /etc/lore
[ -f /etc/lore/env ] || cat > /etc/lore/env <<'ENV'
# Environment for lore-sync.service. Prefer exe.dev integrations (proxies)
# for vendor tokens; put here only what those can't cover.
#
# Extract backend, one of:
#   ANTHROPIC_API_KEY=sk-ant-...                 # Claude API, per-token billing
#   ANTHROPIC_BASE_URL=https://llm.int.exe.xyz   # exe.dev LLM integration (+ any ANTHROPIC_API_KEY value)
#   CLAUDE_CODE_OAUTH_TOKEN=...                  # Claude subscription via the claude CLI (`claude setup-token`)
LORE_EXTRACT=0
# Fold models: LORE_MODEL for a first fold / multi-batch re-fold (default
# claude-opus-4-8), LORE_MODEL_INCREMENTAL for the routine one-batch delta
# (default claude-sonnet-5). Set both to the same id to use one model.
# LORE_CONCURRENCY=3   clients synced at once
ENV
chmod 640 /etc/lore/env
chown root:"$LORE_USER" /etc/lore/env

# The runner's own lore home: remote is the local repos dir, so `lore`
# commands run on the host resolve bare names without SSH.
LORE_HOME_DIR="$(eval echo "~$LORE_USER")/.lore"
install -d -o "$LORE_USER" -g "$LORE_USER" "$LORE_HOME_DIR"
if [ ! -f "$LORE_HOME_DIR/config.json" ]; then
  cat > "$LORE_HOME_DIR/config.json" <<'CFG'
{ "remote": "/srv/lore/repos" }
CFG
  chown "$LORE_USER":"$LORE_USER" "$LORE_HOME_DIR/config.json"
fi

# --- systemd: oneshot service + timer ---
cat > /usr/local/bin/lore-run-all <<'RUN'
#!/usr/bin/env bash
# Wrapper so the extract flag follows /etc/lore/env without editing the unit.
#   lore-run-all              timer (every INTERVAL): sync every client, then fold if LORE_EXTRACT=1
#   lore-run-all --sync-only  on demand (lore refresh / lore_sync_now): sync only, never fold
set -euo pipefail
args=(run-all --repos /srv/lore/repos --work /srv/lore/work --concurrency "${LORE_CONCURRENCY:-3}")
if [ "${1:-}" != "--sync-only" ] && [ "${LORE_EXTRACT:-0}" = "1" ]; then
  args+=(--extract)
fi
exec lore "${args[@]}"
RUN
chmod 755 /usr/local/bin/lore-run-all

cat > /etc/systemd/system/lore-sync.service <<UNIT
[Unit]
Description=lore: sync every context repo
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$LORE_USER
EnvironmentFile=/etc/lore/env
WorkingDirectory=/srv/lore
ExecStart=/usr/local/bin/lore-run-all
TimeoutStartSec=5h
Nice=5
UNIT

# Sync-only twin for on-demand refreshes: `lore refresh --trigger` (and the
# lore_sync_now MCP tool) start this unit and wait for it. It shares the work
# clones with lore-sync.service under run-all's per-client locks, so it can
# run while the timer's fold is still going.
cat > /etc/systemd/system/lore-sync-now.service <<UNIT
[Unit]
Description=lore: sync every context repo now (no fold)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$LORE_USER
EnvironmentFile=/etc/lore/env
WorkingDirectory=/srv/lore
ExecStart=/usr/local/bin/lore-run-all --sync-only
TimeoutStartSec=30min
Nice=5
UNIT

cat > /etc/systemd/system/lore-sync.timer <<UNIT
[Unit]
Description=lore: run sync every $INTERVAL

[Timer]
OnBootSec=2min
OnUnitActiveSec=$INTERVAL
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# --- systemd: the host's page (playbook + live client status) on the exe.dev proxy port ---
cat > /etc/systemd/system/lore-www.service <<UNIT
[Unit]
Description=lore: playbook + client status page
After=network-online.target

[Service]
User=$LORE_USER
ExecStart=$(command -v lore) www --repos /srv/lore/repos --port ${WWW_PORT:-8000}
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now lore-www.service
systemctl restart lore-www.service
systemctl enable --now lore-sync.timer
echo "www:   $(systemctl is-active lore-www.service) on port ${WWW_PORT:-8000} (https://<vm>.exe.xyz via the exe.dev proxy)"
echo "timer: $(systemctl is-active lore-sync.timer); next runs:"
systemctl list-timers lore-sync.timer --no-pager | head -3
echo
echo "Next: from a laptop with ~/.lore/config.json remote set to '$LORE_USER@<this-vm>:/srv/lore/repos',"
echo "      run 'lore setup --channels ...' inside a project repo. Logs: journalctl -u lore-sync -f"
