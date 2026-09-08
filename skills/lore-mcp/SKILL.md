---
name: lore-mcp
description: Query project memory through the lore MCP server (lore_grep, lore_read, lore_recall, lore_remember) — or connect it if it isn't. Use when asked what a client said, asked, or decided; when checking project history or status; when asked to "remember" a fact for the project; or when asked to hook an agent up to lore.
---

# Using lore over MCP

Lore is git-native project memory: Slack history synced daily into a private
context repo, plus derived artifacts and pinned facts. The MCP server exposes
the query surface so you never touch the repo directly. Full docs:
https://github.com/nerdburn/lore

## Connecting the server (if the tools aren't already available)

In a repo that carries a `lore.json` pointer (or is itself a context repo):

```sh
claude mcp add lore -- lore mcp
```

From anywhere, pinned to one project:

```sh
claude mcp add lore -- lore mcp -p <project>      # name from ~/.lore/registry.json
claude mcp add lore -- lore mcp --context owner/lore-<project>   # explicit repo
```

Other MCP clients use the same command in their config:

```json
{ "mcpServers": { "lore": { "command": "lore", "args": ["mcp", "-p", "acme"] } } }
```

If startup fails with `project "<name>" not in registry`, fall back to
`--context owner/repo`; with `no lore.json found`, the cwd isn't linked —
run it with `-p`/`--context`, or see the `lore-onboard` skill.

## What lives where — pick the right tool

Three layers, in trust order:

1. **Pinned facts** (`context/facts.yaml`) — explicitly stored, win over
   everything. Read with `lore_recall`.
2. **Derived artifacts** (`context/derived/` — requests, decisions, roadmap,
   weekly reports) — LLM-extracted, every item cites its source message.
   Also returned by `lore_recall`; filter with `category` (e.g. `decisions`).
3. **Raw streams** (`context/streams/slack/#channel/YYYY-MM-DD.md`) — the
   synced history itself. Search with `lore_grep`, read with `lore_read`.

## Answering questions from memory

- **Start with `lore_recall`** for "what do we know / what's the status /
  what was decided" questions — the structured layers usually answer these
  outright, and their items link to sources you can verify.
- **Drop to `lore_grep` → `lore_read`** for anything specific: quotes, dates,
  "did the client mention X". The pattern is a regex (falls back to literal
  if it doesn't parse); `channel` is a substring filter on the file path.
  Grep returns `file:line` matches — always `lore_read` the day file around
  a hit before quoting it, matches alone lack conversational context.
- **Cite what you found.** Stream files are permalinked markdown; when
  reporting what someone said, include who and when from the surrounding
  context, and note the file/date so the user can check.
- Zero grep hits ≠ "it never happened" — try synonyms and looser patterns
  before concluding; memory only covers synced channels since the backfill
  window.
- Reads re-pull the context repo at most once a minute, so results can lag
  Slack by up to a day (the sync is a daily Action). Say so if recency
  matters to the question.

## lore_remember — the one rule that is not yours to relax

Pin a fact **only on explicit user instruction** ("remember that…",
"pin this"). Never pin your own inferences, summaries, or things you merely
read in the streams — pinned facts outrank everything else, so a wrong pin
poisons the memory. When you do pin:

- one self-contained fact per call, phrased to be true without conversation
  context (absolute dates, full names)
- pass `category` matching existing usage (`client`, `deployment`,
  `decisions`, …) — check `lore_recall` first rather than inventing new ones
- pass `source` (a Slack permalink or stream path) when the fact came from
  somewhere citable
