#!/usr/bin/env bash
# Runs in the case's sandbox cwd (with `claude plugin eval --scaffold`).
# Copies the lore-smoke context repo out of a lore cache into the sandbox
# home (outside the agent's cwd, so only the MCP server reaches it) and
# writes an absolute-path lore.json pointer: no env vars, no writes to the
# real cache. Pins made during the case land in the throwaway copy.
set -euo pipefail
dest="$(cd .. && pwd)/.lore-smoke"
for d in "$HOME/.lore/cache/lore-smoke" /Users/*/.lore/cache/lore-smoke /home/*/.lore/cache/lore-smoke; do
  if [ -f "$d/lore.json" ]; then
    rm -rf "$dest" && cp -R "$d" "$dest"
    printf '{ "context": "%s" }\n' "$dest" > lore.json
    exit 0
  fi
done
echo "lore-smoke cache not found — run: lore recall --context lore-smoke" >&2
exit 1
