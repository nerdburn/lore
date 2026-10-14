# Load: activity counts for a client/project

Status: proposed; implementation has not started. Code reviewed 2026-10-13.

## Product definition

Load measures the activity associated with a client/project over time. Start
with counts by activity type, with evidence behind every count. Preserve actor
and client/team attribution so queries can distinguish human involvement from
agent activity. A PR created by an agent still counts as a PR.

These are activity counts, not estimates of hours or capacity consumed. Do not
combine them into a weighted score in v1. A meeting, email, and decision can all
be related and each count in its own category; their sum is not a count of
independent units of effort. Operational commitments remain separate from the
authoritative SOW capacity commitments in `context/sow/`.

Example questions:

- How many PRs were created for this project last week, by humans versus agents?
- How many technical escalations needed a human decision this month?
- How many client requests and human commitments came out of last week's meetings?
- How many tickets did people move on the Lore board?
- Which events account for the increase in this client's activity?

## Existing storage and review findings

The current pipeline is:

1. Connectors return normalized `Doc` records (`src/types.ts`) and optional
   source-owned files. `sync` persists both (`src/commands/sync.ts`).
2. `writeDocs` stores Markdown day files under
   `context/streams/<source>/<channel>/<day>.md`, with source IDs, timestamps,
   permalinks, and machine metadata (`src/streams.ts`). Most records append;
   GitHub Projects replaces an item's earlier entry within the same day.
3. External issue/PR tables under `context/work/` are current snapshots. Lore's
   own tracker retains mutation history with time, actor, surface, and changes
   (`src/work.ts`). `context/audit.jsonl` records writes but lacks field changes.
4. `extract` detects changed stream files, optionally gates the LLM call, then
   folds whole changed files into requests, decisions, roadmap, and work
   proposals (`src/commands/extract.ts`). Artifact deltas merge by ID.

The following affect the accuracy of Load:

| Finding | Consequence | Required treatment |
| --- | --- | --- |
| The gate can mark files consumed without running the fold (`extract.ts`, `gateSkips`). | Ordinary emails, meetings, and PR activity could disappear from counts if counted only by the LLM. | Run deterministic activity extraction independently of the gate; give semantic Load its own completion tracking. |
| Change detection compares only string length, while GitHub Projects replaces entries (`streams.ts`). | A same-length update is invisible to extraction; intermediate same-day snapshots are overwritten. | Use content digests for changed-file detection and persist distinct source revisions going forward. Digests alone cannot recover overwritten history. |
| Changed day files are folded in full; retries and split-file recovery can repeat material. | Incrementing counters per batch would double count. | Upsert canonical events by stable identity, then aggregate. |
| Source-document deduplication is normally per day file, not global. | A source ID can recur under a different date/channel. | Deduplicate Load by source identity independently of its storage path. |
| `via` identifies an interface, not human versus agent execution. CLI/MCP can record an OS or server-attested identity. | Calling every CLI/MCP action human would inflate human counts. | Retain execution identity, represented/authorizing identity where available, actor kind, and attribution evidence; leave unresolved identities unknown. |
| Lore work changes live in ticket history, not generally in streams. | A stream-only Load pass would miss board moves and assignments. | Scan work history independently, even when there are no new stream files. |
| External tracker snapshots and sync history describe observations, not complete source transitions or their actors. | An imported assignment is not necessarily a new assignment at sync time. | Treat first observations as baselines; label uncertain transition times and do not assert human actors. |
| Requests/decisions are mutable summaries; there is no operational-commitment artifact. | Counting current rows or their updates cannot reliably count historical acts. | Record evidence-backed occurrences, linking to artifacts where appropriate. |

Confirmed locally: replacing a GitHub Project entry's `status: todo` with
`status: done` changes its content but preserves length, so the current fold
does not detect the change. No production code was changed during this review.

## Counting rules

Each accepted event contributes one to its type. Count when the activity
occurred, not when Lore synced or inferred it. Use the following initial units:

| Requested activity | Event / unit | Available evidence and gaps |
| --- | --- | --- |
| PRs created | `pr.created`: one per repository + PR identity, at `created_at` | GitHub opening documents and current tables supply identity, author, and creation time. State updates, reviews, and merges do not create another opening. Human/agent identity needs mapping. |
| Agent escalations requiring technical judgment | `agent.escalation`: one distinct question handed to a human for technical judgment | Infer from explicit conversations initially; add structured agent emission for reliable coverage. Waiting for credentials or routine approval alone does not establish technical judgment. Follow-ups remain attached to the same escalation. |
| Meetings / client communication in Granola | `meeting.held`: one per meeting ID | Notes and delayed transcripts share `meta.meeting`; count once. Retain participants and whether client attendees are known. Extract requests/decisions separately; do not count transcript turns as meetings. |
| Emails to/from the client | `email.received` / `email.sent`: one per RFC Message-ID | Gmail already preserves Message-ID, sender, recipients, and mailbox copies. Deduplicate across mailboxes. Direction is relative to the team; classify client-side participants from contacts/aliases/domains. Keep unrelated or ambiguous direction separate. Attachments and quoted replies add no email events. |
| Figma design activity | `design.version_observed`: one changed file version observed after a baseline; `design.comment_created`: one comment ID | Existing records are changed frame text/index snapshots plus comments. Group frames by file/version, never count frames as edits. Initial import is a baseline. Add an explicit version-observation record even when the rendered frame text is unchanged. Polling does not measure all edits, editing sessions, or design time; latest editor does not identify every contributor. |
| Tickets assigned to humans | `ticket.human_assigned`: a transition into a known human assignment, including creation with a known human assignee | Lore history supplies assignment changes, but creation history only says `created: true`; enrich new creation records with initial assignment. Current assignment alone cannot reconstruct its start time. A reassignment to another human is another assignment event. |
| Tickets requiring human intervention | `ticket.intervention_requested`: one explicit intervention episode | Add structured open/resolved intervention records, with a reason and linked escalation if applicable. Infer only from explicit evidence initially; `blocked` or `review` status alone is insufficient. Reopening after resolution starts another episode. |
| Tickets moved by humans in Lore's board | `ticket.board_moved`: one actual status/rank mutation by a signed-in board user | Use ticket history (`via: web`) and verified actor attribution; status + rank in one operation counts once. No-op moves, sync/fold changes, comments, and edits to titles are excluded. Other human mutation surfaces can be exposed as a separate filter/type later. |
| Production incidents and QA | `incident.opened`: one production incident; `qa.performed`: one distinct test/review session or run with reported results | These are separate types. Existing conversations/tickets can provide inferred evidence, but there is no dedicated ingestion here. Deduplicate incident updates by incident identity. A bug mention is not automatically a production incident or completed QA activity. |
| Production deploys | `deployment.production_succeeded`: one successful deployment identity + environment | The GitHub connector currently collects releases, not deployment/status records. A release or merged PR does not prove production deployment. Add an explicit deployment source; before that, clearly label deployment evidence inferred from explicit announcements. |
| Decisions humans made | `decision.made`: one distinct evidenced choice by a known human | Extend semantic folding; link to an existing decision artifact. Repeated reports of the choice add evidence, while a later reversal is a new event linked to the earlier decision. Unknown speaker/actor stays unattributed. |
| Requests clients made | `client.requested`: one distinct client ask | Extend semantic folding using client attribution. Follow-ups and copied ticket descriptions add evidence to the same ask. A materially new ask is a new event; completion does not remove the original. |
| Commitments humans made | `human.committed`: one explicit undertaking by a known human | Extend the fold with commitment extraction: who agreed to do what, and any explicit due date. A request, tentative suggestion, or automatically created ticket is not itself a commitment. Material recommitments can be new linked events; repeated mentions are not. |

Track event counts and current workload separately. “Assigned during September”
counts assignment transitions; “assigned to humans at September 30” requires
reconstructing state. Likewise, open interventions are a stock, intervention
requests are events. Unknown historical baselines must remain unknown.

## Event storage and identity

Keep text in Git. Add monthly event partitions under
`context/derived/load/YYYY-MM.yaml`, sorted deterministically, plus a small
manifest with schema/extractor versions and coverage. This avoids adding a
database or feeding the entire event history back into every fold. Unknown-date
events belong in a separate undated partition, outside timed counts.

Proposed event fields:

```ts
interface LoadEvent {
  id: string                 // assigned/validated by code; stable across replay
  type: string               // validated versioned event taxonomy
  entity: string             // canonical PR, message, meeting, ticket, etc.
  occurred_at?: string       // original event time, UTC when known
  time_precision: 'instant' | 'day' | 'unknown'
  observed_at: string        // first observed by Lore; not the counting date
  actor: {
    id?: string
    kind: 'human' | 'agent' | 'service' | 'unknown'
    side: 'client' | 'team' | 'vendor' | 'unknown'
  }
  method: 'source' | 'inferred'
  confidence: 'high' | 'medium' | 'low'
  status: 'accepted' | 'candidate' | 'retracted' | 'superseded'
  summary: string
  evidence: Array<{
    doc_id?: string
    history_id?: string
    path: string
    url?: string
    anchor?: string           // validated statement/span within the evidence
  }>
  related: string[]          // other event IDs, request/decision IDs, ticket refs
  attributes: Record<string, unknown> // validated per type
  extractor_version: number
}
```

The context repo supplies project scope. Retain stable source scopes in entity
keys (GitHub repository/node, mail message, meeting, Figma file/version). Add
stable project/client IDs before supporting aggregation across multiple repos;
display names alone are not join keys. A client-wide union must deduplicate
shared source events rather than blindly sum projects. V1 queries one context.

For source events, derive IDs from type + canonical entity + native occurrence
ID. For new Lore history entries, persist an immutable mutation ID and initial
assignment where relevant; for legacy entries use a canonical hash of ticket
identity, timestamp, actor, surface, and change, recording its limitations.
Keep references valid when the existing Git merge code rekeys ticket collisions.

For semantic events, ask the model for evidence anchors and either an existing
event reference or a new candidate. Code validates the evidence and allocates
identity. Retrieve relevant existing events by entity/thread/artifact when
folding so a meeting summary, transcript, email recap, and ticket can attach to
the same event. A hash of the model's paraphrase is not a stable identity.
Ambiguous matches remain candidates rather than silently increasing accepted
counts. Semantic deduplication is an evaluated inference, not an exactly-once
guarantee from the model.

Permit explicit merge/retract/supersede corrections, preserving provenance.
Do not reuse the current artifact merge as-is: it allows id-less appends and
does not provide event validation or correction semantics. Preserve explicit
human corrections as authoritative records outside the regenerable projection.

## Fold integration and recovery

1. Add a Load stage to `extract`, enabled through `extract: [..., "load"]`.
   The current artifact allowlist and entry conditions need an explicit update
   so Load also runs when no other artifacts are enabled.
2. Parse persisted stream documents into structured records and inspect work
   histories. Produce deterministic events before the existing chatter gate,
   including on runs with no new stream material and on runs without an LLM.
3. Use separate source-event and semantic-event checkpoints under
   `state.load`, keyed by content digest/revision and extractor version.
   Enabling Load must backfill already-consumed streams without resetting
   `state.extracted` or replaying ticket-creation side effects.
4. Extend the semantic fold schema/prompt to propose Load events along with
   its existing artifacts. When Load is enabled, v1 bypasses the chatter gate
   for unprocessed semantic material. A future gate may skip semantic work
   only after coverage of every Load category is evaluated; deterministic
   counting is never gated. Artifact progress cannot mark Load complete.
5. Supply only relevant existing event context. Keep event extraction batches
   anchored to source document IDs/spans; split transcripts retain identity.
   Validate and upsert events before advancing the matching checkpoint.
6. Write partitions atomically under a Load writer lock. Retries after a crash
   between event writes and checkpoint writes are safe because IDs upsert.
   Capture input digests before processing so concurrent sync updates remain
   pending. Migrate the ordinary fold's length-only change detection too.
7. Add an explicit Load rebuild/backfill mode that reads local evidence only,
   does not mutate work/requests/decisions, and stages a replacement projection
   before activation. Versioned semantic re-extraction may change inferred
   counts; show a diff and preserve human corrections instead of appending
   every new model interpretation beside the old one.
8. Review `run-all.ts` conflict handling: derived files and checkpoints must
   recover together, and authoritative event/correction records need durable
   merge rules. A successful checkpoint cannot survive a discarded projection
   without triggering recovery. Avoid relying on generic text conflict wins.

Connector additions remain deterministic and persist evidence during sync.
Load reads local evidence during extract; it does not introduce source API
calls into event inference. New agent/intervention signals must also persist
raw records so the projection can be rebuilt.

## Query contract

Add `lore load` and a read-only `lore_load` MCP tool over one shared query
implementation. Proposed interfaces, not currently available:

```sh
lore load --from 2026-09-01 --to 2026-10-01 --tz America/Vancouver --group-by type
lore load --from 2026-09-01 --to 2026-10-01 --type pr.created --group-by actor-kind
lore load --from 2026-09-01 --to 2026-10-01 --group-by week --json
lore load events --type agent.escalation --from 2026-09-01 --to 2026-10-01
```

Use half-open ranges `[from, to)`. Date-only boundaries are interpreted in the
explicit/project timezone, with a documented UTC fallback. Bucket by local
calendar day/week/month, including daylight-saving changes. Store day-precision
evidence as a date with timezone context rather than inventing an exact instant;
exclude it from finer-grained queries or report it as boundary-uncertain.

Return counts by type with source/inferred splits, actor/side filters, accepted
and candidate totals separately, evidence drill-down with pagination, and
source/Load freshness. Default counts include accepted source events and
high-confidence accepted inferences, visibly distinguished. Unknown actor
events do not enter human-only counts. Dated events count by occurrence time;
late transcripts can legitimately revise earlier periods.

Expose per-source/per-kind coverage: enabled/unsupported/partial, known
backfill intervals, polling limitations, extraction backlog, missing transcripts,
and sync failures. Last successful sync alone does not establish historical
completeness. Return an observed count with partial coverage, or unavailable,
rather than presenting every missing source as zero.

Keep ordinary recall compact: optionally include a recent Load summary and a
pointer to the query tool. Do not include all historical events in every recall.
Board charts and weekly-report integration can use this same query layer later.

## Delivery sequence and acceptance criteria

1. **Foundation and source counts:** schema/parser/store, digest checkpoints,
   identity mapping, PR/email/meeting counts, known human board moves,
   query/MCP surfaces, coverage and isolated backfill. No agent/human inference
   from display names alone.
2. **Semantic activity:** decisions, client requests, human commitments,
   technical escalations, interventions, incident and QA evidence. Add
   cross-source reconciliation and corrections. Use a labeled corpus to
   measure false positives, misses, actor attribution, and duplicate events;
   define acceptance thresholds before claiming semantic coverage.
3. **Better instrumentation:** persistent mutation IDs/creation assignments,
   structured escalation and intervention lifecycle records, explicit Figma
   version observations, production deployment/incident/QA source adapters.
   Verify chosen external providers' event identity and retention contracts
   during implementation. Historical data cannot recover events never stored.
4. **Presentation and client rollups:** board charts, weekly comparisons,
   stable client/project scope and cross-project deduplication. Weighting is a
   separate product decision after the raw counts are useful.

Required tests cover:

- Repeat sync/fold/backfill and crash replay produce identical source counts.
- Notes plus a late transcript count as one meeting; a multi-mailbox email
  counts once; PR updates never count as new PRs.
- Multiple changed Figma frames in one observed version count once; first
  import is a baseline and comments use their own IDs.
- A skipped artifact fold still records deterministic Load; failed semantic
  extraction remains pending; Load-only configuration works.
- Same-length stream replacement is detected, and new revision storage keeps
  transitions. Historical overwritten transitions remain explicitly unavailable.
- Board no-ops and sync/fold/MCP mutations do not become human board moves;
  agent identity and authorization identity remain distinct.
- Assignments/interventions distinguish event counts from as-of state.
- Repeated decisions/requests across sources merge; reversals and genuinely
  new commitments remain separate; retractions adjust historical counts.
- Date boundaries, daylight-saving time, day-only evidence, late arrival,
  partial backfill, source failures, and unknown dates/actors are handled.
- Concurrent sync/fold, Git conflict recovery, correction preservation, and
  ticket rekeying cannot lose or duplicate accepted events.
- CLI and MCP share results and respect the existing context/access boundary.

Review validation: 100 existing focused tests passed across streams, extract,
gate, GitHub, Granola, Gmail, Figma, and work. The same-length replacement was
also reproduced in an isolated temporary directory. These validate the current
baseline, not the proposed feature.
