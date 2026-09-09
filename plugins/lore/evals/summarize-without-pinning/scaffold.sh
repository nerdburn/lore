#!/usr/bin/env bash
# Runs in the case's sandbox cwd (with `claude plugin eval --scaffold`); the
# harness executes it from its original location, so BASH_SOURCE finds the
# shared synthetic fixture beside the case directories. Copies it into the
# sandbox home (outside the agent's cwd) and points lore.json at it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/../fixture"
[ -f "$src/lore.json" ] || { echo "fixture not found at $src" >&2; exit 1; }
dest="$(cd .. && pwd)/.lore-eval"
rm -rf "$dest" && cp -R "$src" "$dest"
printf '{ "context": "%s" }\n' "$dest" > lore.json
