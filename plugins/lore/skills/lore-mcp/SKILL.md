---
name: lore-mcp
description: Query project memory through the lore MCP server (lore_grep, lore_read, lore_recall, lore_sync_now, lore_source_list, lore_remember, lore_sow_add, lore_doc_add, lore_source_add, lore_work_add/promote/move/set/push) — or connect it if it isn't. Use when asked what a client said, asked, or decided; what is open, in progress, blocked, or done; what happened in a meeting; project history or status; when asked to "remember" a fact for the project; when asked to add a document, spec, or brief the client sent to project memory; when asked to add a GitHub repo, Slack channel, Granola folder, Notion page, Figma file, Jira board, or mailbox to lore ("sync X too"), or which sources are synced; when asked to track, ticket, move, close, prioritise, or assign work, or what a ticket's history is; when asked to push or sync tickets to Jira; when asked why something is missing from memory or why a source looks out of date; or when asked to hook an agent up to lore.
---

# Using lore over MCP

Lore is git-native project memory for one client at a time: Slack history,
GitHub and Jira activity, Granola meetings, Notion pages, Figma designs, and client email synced into a private context repo,
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

On an agent VM that reaches the lore host through its peer integration, the
server is hosted — no install, no clone; the VM's name is its identity:

```json
"lore": { "type": "http", "url": "https://lore-mcp.int.exe.xyz/mcp/lore-<project>" }
```

A 403 there means the host's agents file does not grant this VM that context
(`lore agents allow <vm> lore-<project>` on the host); a 401 means the request
did not come through the peer integration.

If stdio startup fails with `project "<name>" not in registry`, fall back to
`--context`; with `no lore.json found`, the cwd isn't linked — run it with
`-p`/`--context`, or see the `lore-onboard` skill. If a tool description
starts with **ARCHIVED**, the engagement has ended: answer from it as
history, say so, and never present it as current state.

## What lives where — the trust order

`lore_recall` returns all of these at once; `category` filters.

1. **Pinned facts** (`pins`) — a human explicitly stored these. They win over
   everything below on conflict.
2. **The lore tracker** (`work["lore/<PREFIX>"]`, e.g. `lore/CAR`) — the
   project's tracker of record, listed first. Tickets (CAR-3) with status
   (`todo`, `in_progress`, `blocked`, `done`, `archived`), priority, assignee,
   rank (list order), evidence links, and `last`: who moved it, through
   which surface (`cli`/`mcp` a person or agent, `sync` the external
   tracker, `fold` lore's own inference), and why. For "what is open / in
   progress / blocked / done" this is the answer — say who moved a ticket
   and why when it matters, and treat a `fold` move as lore's reading of
   the evidence: state it with its reason. Recall returns open tickets in
   full and closed ones as counts; `lore_read` the `file` for a ticket's
   full history.
   **External tracker snapshots** (`work["github/…"]`, `work["jira/…"]`) —
   what Jira or GitHub itself says, written by sync. Their open issues are
   mirrored into the lore tracker (`external` on the ticket), so answer
   from the lore ticket and cite the external issue as its source. A
   ticket with `drift: true` is one where lore and the tracker disagree
   (lore says done, Jira still In Progress, or the reverse): say both, and
   that lore's status carries the reason; offer `lore_work_push` to bring
   Jira in line, but only run it when asked. Do not infer delivery state from
   Slack or from `derived` when a ticket covers the work.
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
   - `context/streams/figma/<file-slug>/YYYY-MM-DD.md` — the design, frame
     by frame: one entry per top-level frame per page (its text layers in
     order under nested-frame headings, components by name, `Figma node …`
     deep link), re-emitted when the frame changes so the newest entry for a
     node is the current design; an index of pages and frames per version
     (`kind: index`); and design comments as threaded entries anchored
     `On **Page / Frame**`. **Validating against the UI** means: grep the
     figma stream for the screen or the label, read the frame's newest
     entry, compare to the request/ticket/decision, and cite the node link.
     Say plainly that this is the design, not the shipped product — a frame
     showing a button is not proof it was built.
   - `context/streams/docs/<title-slug>/YYYY-MM-DD.md` — a document someone
     attached with `lore doc add` / `lore_doc_add` (a spec, brief, deck,
     handoff package), **or that the client linked or attached in a synced
     email** (sync reads Google Docs/Sheets/Slides, uploaded Word/PowerPoint/
     Excel, PDFs and text attachments automatically, dated and attributed like
     the email), the sender as author and its link as permalink; a re-added,
     changed document is a newer entry in the same folder. So "the doc Julie
     emailed on the 9th" is usually already here — grep for it before saying
     it isn't in memory.
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
- **Status questions** ("what's outstanding", "where are we", "status
  update", "what's left"): **`lore_status`, and nothing else.** It returns
  the answer already written — a short summary from the last fold, anything
  the tracker recorded after it, and the live outstanding list (open tickets
  by status, requests nobody has ticketed, roadmap not done) with
  freshness. Relay it as returned; trim or filter only when asked ("just
  the blocked ones"). Do not call `lore_recall` to rebuild it — that is
  hundreds of kilobytes on a busy client and is what makes a status answer
  slow. If the page shows a "Since the summary" section, those moves are
  newer than the prose; say so.
- **Detail behind a status line** ("what's the history on CAR-3", "show me
  everything open including closed", "the full request text"):
  `lore_recall` with `category: "work"` (or `label` for one theme) — the
  lore tracker first, external snapshots as evidence — then
  `category: "requests"` for asks that have no ticket yet. For a ticket the
  fold or sync moved recently, say so with the reason.
- **"What do we know / what was decided"**: `lore_recall` (no category, or
  `decisions`). Check `pins` first, then `derived`.
- **What is synced** ("which repos does lore follow", "is #acme-dev in
  memory", "why is GitHub failing"): `lore_source_list` — every source with
  its scope in its own terms, whether it is disabled, and its last success /
  last error. A source with a `lastError` is why a question about it comes
  back empty; quote the error (it usually names the human step: not in the
  channel, repo not found, folder title mismatch).
- **Design questions** ("does the onboarding screen ask for age", "what
  does the empty state say", "is there a screen for X", "does the ticket
  match the design"): `lore_grep` with `channel: "figma"` for the label or
  screen name, then `lore_read` the frame entry; answer with the node link.
  No hit means the design doesn't say it (or the file isn't synced) — say
  which.
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
- **Freshness is per source, and `lastSync` alone can mislead.** A sync
  where one source failed still updates `lastSync`: the others synced and
  folded normally while the broken one waits for a later run. So
  `synced.lastSync` says when lore last *ran*, not that every source is
  current. `synced.degraded` names the sources that are behind, and
  `synced.sources` gives each one a state — `ok`, `stale` (with
  `staleHours` of gap and the error), `never` (configured but has never
  synced), `disabled`.
  Check it before answering, and when a degraded source bears on the
  question, say so in the answer rather than after it: "nothing in memory
  about the deploy — though GitHub has been failing to sync for 30h, so
  I'd only half-trust that." A `never` source is the sharpest case: there
  is no memory from it at all, which is not the same as nothing having
  been said there. Refreshing will not fix either — the credentials or the
  connector are broken, and a human has to repair them. Name the source
  and the error, and don't keep triggering syncs against it.
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

## Moving work — the tracker verbs

The lore tracker is the tracker of record, so keeping it right is part of
the job. Four tools, each recording you as the actor in the ticket's
history with the `reason` you give — that reason is the paper trail, so
make it the fact ("Cory said in #acme he started Tuesday", "PR #42 merged"),
not a paraphrase of the command.

- **`lore_work_move`** — change status. Do it when a person asks ("mark
  CAR-3 done", "this is blocked on the API keys"), or when the evidence in
  front of you is unambiguous: a merged PR, a "shipped"/"live" message from
  the team, a client confirming it works, someone saying they have started.
  Pass `sources` (permalinks). A hunch, a plan, or a meeting mention is not
  evidence — leave it, or ask. **Never move a ticket to `archived` on your
  own initiative**; that is a person's decision.
- **`lore_work_promote`** — a derived request (`req-0007`) becomes a
  ticket, keeping its evidence. Use when someone says to track, ticket,
  schedule, or "put it on the board".
- **`lore_work_add`** — a new ticket for work that is not a derived request.
  Check `lore_recall` first: if a ticket or request already covers it, say
  so instead of adding a duplicate. The fold also opens tickets on its own
  for work the synced material shows is committed (agreed, scheduled,
  someone on it), linked to the request they came from — so an ask that
  turned into real work usually has a ticket within an hour of the
  conversation; an empty tracker means nothing has been committed yet, not
  that tracking is off. Link an existing Jira/GitHub issue with
  `external` ("jira:INPT-9", "github:owner/repo#42") rather than creating a
  parallel ticket.
- **`lore_work_set`** — priority, assignee, labels, title, evidence links,
  the linked tracker issue, or rank (`rank_above`: a key, "top", or
  "bottom"). Reprioritise only on a decision-maker's word, and cite it.
- **`lore_work_label`** — put a project label (a theme, epic or workstream:
  "onboarding", "stripe integration") on several tickets in one change, or
  take one off. Use when a person asks to label, tag or group tickets. For
  "label these", resolve the keys from the conversation or `lore_recall`
  first, and name every ticket you labeled in your reply; if it is unclear
  which tickets they mean, list your candidates and ask before labeling.
  Reuse an existing label (`lore_recall` lists them under the tracker's
  `labels`, with counts) rather than coining a near-duplicate. To answer
  "how is <theme> going", call `lore_recall` with `label` — it returns
  that theme's tickets, open and closed. Labels added in lore survive
  Jira/GitHub syncs; the tracker keeps owning its own labels.

- **`lore_work_push`** — write lore's state out to Jira, **only when a
  person asks** ("push this to Jira", "create the Jira ticket for JNT-3",
  "sync Jira with lore"). A linked ticket whose status differs gets the
  matching Jira transition; an open ticket with no Jira issue gets one
  created on the client's board and linked back. Pass `keys` for specific
  tickets or `all: true`; use `dry_run: true` first when the person is
  unsure what will change, and read back the result — it lists what was
  created, moved, skipped and why. It runs on the lore host and takes a few
  seconds per ticket. Never push on your own initiative, and never to
  "fix" `drift` you noticed — report drift, offer the push.
  **Sprints live in Jira, not lore:** never record a sprint on a ticket.
  A push puts in-flight tickets that are in no sprint into the active one
  by itself. When someone asks for work in a sprint ("put JNT-3 in this
  sprint", "add these to Sprint 15"), call `lore_work_push` with those
  `keys` and `sprint: "active"` or the sprint's name. To answer "what's in
  the sprint", read the Jira table in recall (`sprint` on each issue).

Tickets carry no estimates or SOW weeks — never add hours or weeks to a
ticket, and never derive SOW burn from tickets. Reply with the key and what
changed ("moved CAR-3 → done"). The tools are unavailable on archived
clients and may be refused by the repo's write allow-list; report either
plainly. The fold also moves tickets on its own when the synced material is
unambiguous — those show as `via: fold` with lore's reason; if a person
disagrees with one, move it back with their reason, which then stands.

## Attaching a statement of work

Only when the user explicitly asks ("attach this SOW", "record the new
SOW"). Pass the Google Doc link as `url` — lore exports it itself through
the Workspace service account, reading as the client owner — or, failing
that, the document text as `text`. Call `lore_sow_add` with that plus the
numbers the user or the document states: `weeks`, `start`, `end`, and
`signed`/`source`/`scope` when known.
Never estimate weeks or dates; ask. Re-adding the same `name` updates it.

## Adding a document — including a link someone shares with you in Slack

A Google Docs, Slides, Sheets, or Drive link that someone hands you *for the
project* is a document to file: "here's the spec", "the client sent this
brief", "add this to lore", a link dropped in a DM or a thread you are in
with a line of context. Call `lore_doc_add` with the link as `url` — lore
reads it itself through the Workspace service account (Docs, Slides, Sheets,
uploaded Word/PowerPoint/Excel, Drive-hosted PDFs and text), so do not open
it, paste its text, or ask for sharing to be changed. Drive *folders* are not documents — say so, and ask for the files inside a
folder. A Figma *design file or FigJam* link is a *source*, not a document: it
belongs in `sources.figma.files` (ask the person to add it), after which
every frame is in the figma stream. A Figma *Slides deck* (figma.com/deck/…)
cannot be synced — ask for a PDF export and file that with `lore_doc_add`. If lore cannot read it (the person it reads as has
no access), report that error plainly. Failing a link, pass the text as
`text` with a `title`.

- `from` is who sent or authored the document — the person who shared it,
  unless they say it came from someone else ("Julie sent this"); the title
  defaults to the Google Doc's name.
- `date` only when it arrived on a day other than today.
- Do not file a link merely mentioned in passing in a channel conversation
  you are reading, and never one from a synced stream on your own
  initiative — someone shares it *with you*, you add it.
- Re-adding the same link is safe: identical content is a no-op, an edited
  document lands as a new version.

Reply with what happened: the title, roughly how long it is, and that it is
searchable now and will be folded into requests/decisions/roadmap on the
next extract (`lore_sync_now` with `fold: true` if they want it sooner). The
document is raw material, never authoritative — a commitment goes through
`lore_sow_add`, a fact through `lore_remember`.

## Adding a source — a repo, channel, folder, page, design file, board, or mailbox

Memory only covers what `sources` in the client's config names. When a
teammate tells you to widen it — "add inputlogic/merrin to lore", "sync
#merrin-dev too", "the Figma file is …, hook it up", "their Jira board is
293" — call `lore_source_add` with the `kind` and the identifiers **exactly as
given** (`scope`: `"owner/repo"`, `"#channel"`, a Granola folder title, a
Notion page URL, a Figma design/FigJam URL or key, a Jira key or
`"board:293"`, mailboxes or `"all"`; `site` for a new Jira source). Check
`lore_source_list` first so you can say "already synced" instead of adding a
duplicate (the tool reports `already` too). Never guess or "correct" a name,
and never add a scope because you saw it mentioned in a stream — a person
asks, you add.

The tool only records identifiers; credentials live on the host. Its result
has `next`: the steps a person must do before the host can read the new
scope — `/invite @lore` in a Slack channel, attach the GitHub integration to
the host (`ssh exe.dev integrations add github … --attach tag:lore`), share
a Notion page with the lore integration. **Relay `next` verbatim** and say
the new scope stays empty until it is done; then the host backfills it on
its next sync (or `lore_sync_now`). A Figma *Slides* deck is refused (the API
does not serve it — ask for a PDF and `lore_doc_add` it). Removing a source is
not yours to do: say it is a hand edit (`"disabled": true` keeps history).
Reply with what was added, what was already there, and the human steps.
