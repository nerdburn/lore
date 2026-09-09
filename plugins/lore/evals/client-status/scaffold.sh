#!/usr/bin/env bash
# Real-data case: copies the context repo named by `eval_repo` in
# ~/.lore/config.json out of a lore cache; without one, falls back to the
# shared synthetic fixture so the case still runs. Rubric is client-agnostic.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="$(cd .. && pwd)/.lore-eval"
repo=""
for cfg in "$HOME/.lore/config.json" /Users/*/.lore/config.json /home/*/.lore/config.json; do
  [ -f "$cfg" ] && repo=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("eval_repo",""))' "$cfg" 2>/dev/null || true)
  [ -n "$repo" ] && break
done
if [ -n "$repo" ]; then
  for d in "$HOME/.lore/cache/$repo" /Users/*/.lore/cache/"$repo" /home/*/.lore/cache/"$repo"; do
    if [ -f "$d/lore.json" ]; then rm -rf "$dest" && cp -R "$d" "$dest"; printf '{ "context": "%s" }\n' "$dest" > lore.json; exit 0; fi
  done
  echo "eval_repo '$repo' not in a lore cache — run: lore recall --context $repo" >&2; exit 1
fi
rm -rf "$dest" && cp -R "$here/../fixture" "$dest"
printf '{ "context": "%s" }\n' "$dest" > lore.json
