---
name: lore-mcp
description: Query project memory through the lore MCP server (lore_grep, lore_read, lore_recall, lore_sync_now, lore_remember) — or connect it if it isn't. Use when asked what a client said, asked, or decided; what is open, in progress, blocked, or done; what happened in a meeting; project history or status; when asked to "remember" a fact for the project; or when asked to hook an agent up to lore.
---

# Using lore over MCP

Lore is git-native project memory for one client at a time: Slack history,
GitHub and Jira activity, Granola meetings, Notion pages, and client email synced into a private context repo,
plus LLM-derived artifacts and explicitly pinned facts. The MCP server
exposes the query surface so you never touch the repo directly. Full docs:
https://github.com/nerdburn/lore

## Connecting the server (if the tools aren't already available)

In a repo that carries a `lore.json` pointer (or is itself a context repo):

```sh
claude mcp add lore -- lore mcp
```

From anywhere, pinned to one project:

```sh
claude mcp add lore -- lore mcp -p <project>          # name from ~/.lore/registry.json
claude mcp add lore -- lore mcp --context lore-<project>   # explicit repo: a bare name (self-hosted) or owner/repo (GitHub)
```

If startup fails with `project "<name>" not in registry`, fall back to
`--context`; with `no lore.json found`, the cwd isn't linked — run it with
`-p`/`--context`, or see the `lore-onboard` skill. If a tool description
starts with **ARCHIVED**, the engagement has ended: answer from it as
history, say so, and never present it as current state.

## What lives where — the trust order

`lore_recall` returns all of these at once; `category` filters.

1. **Pinned facts** (`pins`) — a human explicitly stored these. They win over
   everything below on conflict.
2. **Work tables** (`work`, e.g. `github/acme__web`, `jira/ACM`) — the
   *source system's* own record, written by sync, never by an LLM. For anything about delivery
   state — what is open, closed, merged, assigned, labelled, in which
   milestone — this is the answer. Do not infer issue state from Slack or
   from `derived` when a work table covers the repo. Recall returns open
   items in full and closed/merged as counts; for a closed item's details,
   `lore_read` the `file` it names.
3. **Derived artifacts** (`derived`: `requests`, `decisions`, `roadmap`,
   `contradictions`) — LLM-extracted from the raw material; every item cites
   a source. Good for "what has the client asked for" and "what was decided";
   `contradictions` lists pins that fresh evidence disputes — surface those.
4. **Weekly reports** (`reports`) — the last few generated status reports.
   **Statements of work** (`sow`) — human-attached commitments: human-weeks
   sold, effective date, status, named scope if any. As authoritative as
   pins for what was committed. Weeks *allocated* against an SOW are not
   tracked yet, and calendar time is never a proxy for them — never say how
   much of an SOW is used or left. Use it for "what did we commit to", "how
   many weeks did we sell", and to flag a request outside named scope.
5. **Raw streams** — the synced material itself, one markdown file per
   source, channel/repo/folder, and day:
   - `context/streams/slack/#channel/YYYY-MM-DD.md` — messages, threads
   - `context/streams/github/owner_repo/YYYY-MM-DD.md` — issues/PRs when
     opened and on each state change, comments, reviews, commits, releases
   - `context/streams/granola/<Folder>/YYYY-MM-DD.md` — meeting notes +
     AI summary, and the transcript as a threaded reply
   - `context/streams/jira/<KEY>/YYYY-MM-DD.md` — issues when created and on
     each status change, and comments (Jira's status names, e.g. "In Review")
   - `context/streams/notion/<Top-level page>/YYYY-MM-DD.md` — a Notion
     page rendered to markdown each time it was edited (documentation
     history; the newest snapshot is the current page)
   - `context/streams/gmail/<client domain>/YYYY-MM-DD.md` — one doc per
     email between the team and the client (subject, from/to/cc, body with
     quoted history trimmed, attachment names); replies are threaded, and
     `mailboxes` in the id comment says whose inboxes it was found in
   Search with `lore_grep`, read with `lore_read`.

Every doc carries an id comment with machine ids (Slack user/channel ids,
GitHub numbers and node ids, Granola meeting ids and attendee emails) and a
permalink. Meeting content is **evidence, not a decision**: something said
in a meeting becomes a decision only when a decision-maker confirmed it —
look for that in Slack or a pin before stating it as settled.

## Answering questions from memory

- **Budget / commitment questions** ("how many weeks did we sell", "is
  this in scope"): `lore_recall` with `category: "sow"`; cite the SOW's
  `file`. "How much is left" cannot be answered until the scheduling source
  is connected — say so rather than reasoning from dates.
- **Status questions** ("what's open / in progress / done", "what's
  outstanding for the client"): `lore_recall` with `category: "work"` for
  tracker state, then `category: "requests"` for asks that have no ticket
  yet. Say which is which.
- **"What do we know / what was decided"**: `lore_recall` (no category, or
  `decisions`). Check `pins` first, then `derived`.
- **Anything specific** — quotes, dates, "did they mention X", "what did
  the client say in Tuesday's call": `lore_grep` → `lore_read`. The pattern
  is a regex (falls back to literal if it doesn't parse); `channel` is a
  substring filter on the path (`#acme`, `github`, `granola`, a folder
  name). Grep returns `file:line` matches — always `lore_read` the day file
  around a hit before quoting; a match alone lacks conversational context.
- **Cite what you found.** Give who and when from the surrounding context,
  and the permalink or stream path, so the user can check.
- **Freshness — recall first, refresh second.** `lore_recall` returns
  `synced.lastSync` and `synced.lastExtract`. The host syncs and folds on a
  timer (every 15 min), so recall is normally at most ~15 minutes behind
  and is the answer to "give me an update": the work tables, requests,
  decisions, roadmap, and the latest weekly report are the up-to-date
  summary. **Do not refresh before answering.** Answer from recall, and
  always state the freshness ("synced 6 min ago, folded 12 min ago").
  Then refresh only when one of these holds:
  - the user asks for fresh data or says something just happened;
  - `lastSync` is older than ~20 minutes (the timer has missed a run) —
    say so and offer to trigger one;
  - the question is about the last few minutes, or about a specific thing
    you cannot find and which may have arrived since `lastSync`.
  Otherwise, close with the offer: "Memory is from 14:32; want me to run a
  refresh (~1–2 min)?" — and refresh only if the user says yes.
  **Never run `lore sync` yourself** — an agent has neither the credentials
  nor the network for it. To refresh, call `lore_sync_now` (it asks the host
  to sync now and waits — about a minute; if a run is already in flight it
  waits for that one). Fresh raw material is then in `lore_grep`/`lore_read`;
  the derived lists behind `lore_recall` (requests, decisions, roadmap) only
  update with `fold: true` (a minute or two more), so use `fold: true` when
  the refreshed answer must come from recall, and sync-only when you will
  read the raw streams yourself. It is rate-limited to once per 5 minutes.
  Check `outcome`: a `failed` host run comes back in the result rather than
  as an error — say so instead of presenting the data as fresh. With
  `trigger: false` it only pulls what the host already has.
- Zero grep hits ≠ "it never happened" — try synonyms and looser patterns;
  memory covers only the configured channels, repos, and meeting folders,
  since the backfill window.

## lore_remember — the one rule that is not yours to relax

Pin a fact **only on explicit user instruction** ("remember that…", "pin
this"). Never pin your own inferences, summaries, meeting takeaways, or
things you merely read in the streams — pins outrank everything, so a wrong
pin poisons the memory. If the user asks you to remember something you can
already see in a work table or derived artifact, say it is already tracked
and ask whether they still want a pin. When you do pin:

- one self-contained fact per call, phrased to be true without conversation
  context (absolute dates, full names)
- `category` matching existing usage (`client`, `deployment`, `decisions`,
  …) — check `lore_recall` first rather than inventing new ones
- `source` (a permalink or stream path) when the fact came from somewhere
  citable

The tool is unavailable on archived clients and may be refused by the repo's
write allow-list; report either plainly rather than working around it.

## Attaching a statement of work

Only when the user explicitly asks ("attach this SOW", "record the new
SOW"). Pass the Google Doc link as `url` — lore exports it itself through
the Workspace service account, reading as the client owner — or, failing
that, the document text as `text`. Call `lore_sow_add` with that plus the
numbers the user or the document states: `weeks`, `start`, `end`, and
`signed`/`source`/`scope` when known.
Never estimate weeks or dates; ask. Re-adding the same `name` updates it.
