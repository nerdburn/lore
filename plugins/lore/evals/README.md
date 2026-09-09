# lore plugin evals

Behavioural checks for the `lore-mcp` skill + MCP server: does an agent with
the plugin answer from the right layer, cite sources, and refuse to pin
without instruction? Each case runs against the throwaway `lore-smoke`
context repo (GitHub activity of nerdburn/lore, no Slack), so it needs a
machine whose `~/.lore/config.json` can resolve `lore-smoke`.

```sh
CLAUDE_CODE_WALNUT_SPIRE=1 claude plugin eval ./plugins/lore --scaffold --runs 1 --max-cost-usd 3 --no-publish \
  --allow-tools mcp__plugin_lore_lore__lore_recall mcp__plugin_lore_lore__lore_grep mcp__plugin_lore_lore__lore_read mcp__plugin_lore_lore__lore_remember
```

Cases are `case.yaml` files (`schema_version`, `context.scaffold_script`,
`execution.prompt`, `graders[]`). The harness runs each case in a sealed
sandbox with its own `$HOME` and strips `LORE_*` variables, so
`--scaffold` runs each case's `scaffold.sh`, which copies the `lore-smoke` repo out of
your `~/.lore/cache` into the sandbox and writes an absolute-path `lore.json`
pointer for the plugin's `lore mcp` server. Pins made by the explicit-pin
case land in that throwaway copy, never in your cache. MCP
responses are recorded into `mocks/` on the first run and replayed after
(`--mocks off` to hit the live server).
The default ablation arm runs each case without the plugin, so the report
shows what the skill adds. The judge defaults to haiku; pass
`--judge-model sonnet` when a rubric verdict looks wrong before loosening the
rubric.
