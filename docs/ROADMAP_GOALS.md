# Roadmap goals and delivery work

The roadmap explains the project's overarching short- and long-term outcomes,
why they matter, and how they guide work priorities. A goal can span several
Jira epics or Lore tickets. An epic name alone is not evidence of a goal.

Goals stay in `context/derived/roadmap.yaml`. Each has its existing stable
`id`, an English outcome in `item`, `kind: goal`, `horizon` (`short_term`,
`long_term`, or `unspecified`), `why`, `success`, `priority`, `priority_reason`,
`status`, a cited `source`, and supporting Lore keys in `work_items`.
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
