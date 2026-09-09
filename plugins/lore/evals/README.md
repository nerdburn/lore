# lore plugin evals

Behavioural checks for the `lore-mcp` skill + MCP server: does an agent with
the plugin answer from the right layer, cite sources, and refuse to pin
without instruction? Each case runs against the throwaway `lore-smoke`
context repo (GitHub activity of nerdburn/lore, no Slack), so it needs a
machine whose `~/.lore/config.json` can resolve `lore-smoke`.

```sh
CLAUDE_CODE_WALNUT_SPIRE=1 claude plugin eval ./plugins/lore --runs 1 --max-cost-usd 3 --no-publish \
  --allow-tools mcp__plugin_lore_lore__lore_recall mcp__plugin_lore_lore__lore_grep mcp__plugin_lore_lore__lore_read mcp__plugin_lore_lore__lore_remember
```

Each case sets `env: LORE_CONTEXT: lore-smoke` in its frontmatter, which the
plugin's `lore mcp` server honours as the context to serve (the same
mechanism lets any MCP client config pin a project without flags). MCP
responses are recorded into `mocks/` on the first run and replayed after
(`--mocks off` to hit the live server).
The default ablation arm runs each case without the plugin, so the report
shows what the skill adds.
