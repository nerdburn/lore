# Roadmap goals and delivery work

The roadmap explains the project's overarching short- and long-term outcomes,
why they matter, and how they guide work priorities. A goal can span several
Jira epics or Lore tickets. An epic name alone is not evidence of a goal.

Before the team takes ownership, goals are derived in `context/derived/roadmap.yaml`. Each has its existing stable
`id`, an English outcome in `item`, `kind: goal`, `horizon` (`short_term`,
`long_term`, or `unspecified`), `why`, `success`, `priority`, `priority_reason`,
`status`, a cited `source`, and supporting Lore keys in `work_items`.
When the source sets a calendar target, `timeframe.period` records a month
(`2026-11`), quarter (`2027-Q1`), or year (`2026`). `timeframe.stated_on`
is the source date. For example, “next quarter” said on November 27, 2026
stays Q1 2027 when recalled in January. Targets extending more than one
year from the statement are represented as open-ended long-term goals.
Unknown rationale and success criteria remain empty; timing is never inferred
from priority. Supporting tickets keep their own delivery status, and closing
them does not automatically mark the goal achieved.

The fold links relevant existing tickets and can propose priority or ordering
changes when a cited goal decision establishes a concrete tradeoff. Its reason
must explain the goal and the ticket's contribution. A goal's priority is not
copied to every supporting ticket. Inferred goal relationships must not override
explicit human priority decisions. Existing confidence, citation and newer-human
decision protections still apply.

Roadmap queries through `lore_recall category=roadmap` and `lore recall roadmap`
return English outcomes grouped by horizon, with rationale and implications for
work priorities. Supporting work uses descriptions followed by bracketed ticket
keys. `lore recall roadmap --json` retains structured access, including the old
derived data. Unfiltered recall adds a `roadmap` object with English `text` and
structured `goals`.

Old roadmap entries without `kind` are explicitly awaiting review; they are not
silently presented as strategic goals. During a fold, evidenced goals can be
enriched in place. An old task-shaped entry becomes `kind: work`, retaining its
id, wording, source and status in Git, and is excluded from the goal view. This
classification does not complete, archive or create a ticket. New concrete work
belongs only in the Lore tracker. No new goal is invented merely to group tasks.

## Incoming requests

Each client project keeps its own roadmap. During a conversation the agent
can call `lore_request_triage` with a new ask. The response includes current
work in flight and up to five queued tickets in tracker rank order. With
`TYPESAFE_API_KEY` configured, Jev evaluates each active goal independently
and suggests direct matches scoring at least 0.85. If Jev is unavailable,
the response returns the outcomes for the agent to review.

The regular fold reads the conversation and records applicable `goal_ids`
on requests. The Requests tab shows the linked outcomes. Roadmap recall
also follows the request through promotion to its ticket. An unmatched
request can stay open. To change the order, record the client's or lead's
decision identifying the work that moves.

## Setting goals with the client

Open **Goals** on the project board for a monthly or quarterly planning
meeting. Use **New goal** or **Edit** to record the agreed outcome, target
period, success criteria, priority guidance, and an optional meeting-notes
link. Mark an outcome achieved when it is met, or retired when plans
change. Past goals and their existing links stay on the page.

The first save copies the project's roadmap to `context/goals.yaml`,
preserving IDs and links. That file becomes authoritative for the board,
recall, status, request triage and subsequent folds. The fold can still
match requests to active goals. Projects that have never saved a goal
continue to use their derived roadmap.

Board admins can edit goals. A board member can also edit if their email
matches the project owner or a team-side contact (including an alias).
Other board users can view the goals. Archived boards are read-only.
