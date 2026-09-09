#!/usr/bin/env bash
# Like the other cases' scaffold, but for REAL client data: copies the context
# repo named by `eval_repo` in ~/.lore/config.json (falls back to lore-smoke)
# into the sandbox home and points lore.json at it. The case's rubric is
# deliberately client-agnostic so this file can live in a public repo.
set -euo pipefail
dest="$(cd .. && pwd)/.lore-eval"
repo=lore-smoke
for cfg in "$HOME/.lore/config.json" /Users/*/.lore/config.json /home/*/.lore/config.json; do
  if [ -f "$cfg" ]; then
    r=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("eval_repo",""))' "$cfg" 2>/dev/null || true)
    if [ -n "$r" ]; then repo="$r"; break; fi
  fi
done
for d in "$HOME/.lore/cache/$repo" /Users/*/.lore/cache/"$repo" /home/*/.lore/cache/"$repo"; do
  if [ -f "$d/lore.json" ]; then
    rm -rf "$dest" && cp -R "$d" "$dest"
    printf '{ "context": "%s" }\n' "$dest" > lore.json
    exit 0
  fi
done
echo "context repo '$repo' not in a lore cache — run: lore recall --context $repo" >&2
exit 1
