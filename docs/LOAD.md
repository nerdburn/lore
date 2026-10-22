# Load: activity counts for a client/project

Status: deterministic counts and semantic decisions/requests/commitments
implemented and enabled on lore-host on 2026-10-14. Historical validation uses isolated copies
of Jointly, Momday, and Coincards. Live rollout status is recorded below.

## Available now

`lore load`, `lore load events`, `lore load rebuild`, and the read-only
`lore_load` MCP tool share one query implementation. The first slice counts
retained PR openings, emails, meetings, Lore board mutations, and explicit
assignment transitions without an LLM. The separate semantic stage adds
decisions, customer requests, and human commitments using the configured LLM.
Neither stage needs Redis or a new database.

Configure project actors in `lore.json`. An actor has a stable identity, a kind
(`human`, `agent`, `service`, `unknown`), and zero or more project roles:
`customer`, `account_manager`, `client_strategist`, `technical_lead`,
`software_developer`, `designer`. Customer is the relationship role; there is
no additional client/team field in this registry. Existing client contacts
remain compatible: explicitly client-side contacts supply the customer role.

```json
"load": {
  "enabled": true,
  "timezone": "America/Vancouver",
  "actors": [
    {
      "id": "shawn", "name": "Shawn", "kind": "human",
      "identities": ["email:shawn@inputlogic.ca", "github:nerdburn"],
      "roles": [
        { "role": "account_manager" },
        { "role": "client_strategist", "to": "2026-10-13" }
      ]
    },
    {
      "id": "stephanie", "name": "Stephanie", "kind": "human",
      "identities": ["email:stephanie@inputlogic.ca"],
      "roles": [{ "role": "client_strategist", "from": "2026-10-13" }]
    }
  ]
}
```

Role dates use the project timezone and `[from, to)` intervals. The example
assigns Momday's strategist role to Stephanie starting October 13. Missing
start dates mean current mappings applied to retained history, not a verified
historical tenure. A known person can have no known role on another project.
Map shared agent identities separately from the people who may operate them.
Account attribution cannot establish whether a human-authored PR used AI.

```sh
# In Git contexts, commit source/config changes before building: input is pinned to HEAD.
lore load rebuild --preview --from 2026-09-01 --to 2026-10-01 --json
lore load rebuild
lore load --from 2026-09-01 --to 2026-10-01 --type pr.created --group-by role
lore load --type meeting.held --role technical_lead --participation attendee
lore load --type ticket.assigned --actor-kind human --participation assignee
lore load events --type pr.created --limit 20 --json
```

`load.enabled` opts into the self-hosted `run-all` stage after committed sync,
independently of `--extract` and the chatter gate, and again after the fold
commits, so the published counts include tickets the fold moved and the
semantic pass. Manual rebuild/preview also
works before enabling it. Rebuild replaces only the derived projection; it
does not replay ticket creation or change requests/decisions. Queries read the
prebuilt projection and report freshness; they do not rebuild on demand.
Freshness compares `lore.json`, streams and the tracker with the projection's
input revision. `state.json` is ignored there: every sync rewrites its cursors
and timestamps, and Load reads only per-source health from it.

### Across projects

```sh
lore load all --from 2026-10-01 --to 2026-11-01          # one table, every project in ~/.lore/registry.json
lore load all --type ticket.completed --json
lore mcp --portfolio                                      # adds the lore_load_all tool (the team plugin passes it)
```

`lore load all` reads each registered project's prebuilt snapshot (pulling each
clone unless `--no-pull`) and prints one row per project with unique totals.
Event IDs come from the native entity, so a repo or mailbox that several
projects sync (the white-label brands share one repo) counts in each project's
row but once in the total; `shared` names those overlaps. Archived projects are
listed, not counted; a project without a snapshot is an error row. Role and
actor filters stay per project. `lore_load_all` shows every client's counts, so
only `lore mcp --portfolio` registers it (the team's Claude Code plugin does);
the hosted per-context endpoint never does, and an enso agent a client can talk
to should not pass the flag.

The v1 projection is one atomically replaced `context/derived/load.json`
envelope containing events, SHA-256 input digests, input Git revision, coverage,
and schema/extractor versions. A writer lock serializes rebuilds. A failed
build leaves the previous snapshot intact; unchanged inputs preserve its bytes.
One envelope keeps the checkpoint and events together during publication and
Git conflict recovery. Monthly partitions are deferred until scale warrants
a versioned manifest/publication design. A small bounded in-process query
cache retains at most four snapshots of up to 8 MiB each.

Participation defaults to `involved` (primary actor and recorded participants).
Use `performed` for the primary actor, or `attendee`, `recipient`, `assignee`
for a specific relationship. Meetings have attendees, not an invented performer.
Role and actor groups overlap: one meeting can involve several roles. Counts
across types never form an effort score. `ticket.assigned` includes assignments
to any actor kind; filter human assignees explicitly. Unknown email direction
is visible as `email.unclassified` rather than silently omitted.

`ticket.completed` counts each non-archived Lore work item once, at its first
recorded transition into `done`, across web, CLI/MCP, Slack, fold, and tracker
sync history. Reopening and completing it again adds no delivery. Work-item
creation, archival, and a current `done` snapshot without a recorded transition
are excluded. Archived items are excluded even if previously completed.
Unknown completion dates remain undated candidates instead of receiving a
later completion date. Counts describe recorded completion, not independently
verified delivery. The recording surface and actor remain visible; the actor
who recorded completion is not assumed to be the person who implemented it.
These are source-history counts, including previously inferred fold changes;
no new model calls are needed. CLI/JSON/MCP include a completion breakdown by
recording surface. Rebuild older projections to include this event type.

```sh
lore load --type ticket.completed
lore load events --type ticket.completed --json
```

New Lore writes carry immutable history IDs and operation IDs; one board drag's
status/rank changes count once. Initial assignments are preserved on creation.
Legacy board status/rank entries lack operation IDs and remain **candidates**,
not exact user-action counts. Source coverage is partial or unavailable, never
asserted complete from a successful sync. Ingestion timestamps unavailable in
historical data are not invented.

## Historical trial: 2026-10-14

These are September 1–October 1 counts in `America/Vancouver`, from isolated
Git copies on lore-host. Trial-only role commits and projections were not
pushed to the live context repositories. Named GitHub mappings were confirmed
by the user; project roles use the supplied assignments. Shared agent accounts
remain separate from the named humans.

| Project | PRs | Human accounts | Agent accounts | Unknown accounts | Meetings | Classified customer emails |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Jointly | 113 | 67 | 3 | 43 | 7 | Unavailable |
| Momday | 152 | 146 | 0 | 6 | 13 | 17 sent, 29 received |
| Coincards | 73 | 49 | 24 | 0 | Unavailable | Unavailable |

Useful role findings:

- Momday: Cory, the technical lead, authored 131 PRs; Adriaan and Erik, the
  software developers, authored 11 and 4. Recorded technical-lead attendance
  covers 6 of 13 meetings, and Shawn's account-manager/strategist attendance
  covers 5. The same meetings can contribute to multiple roles.
- Jointly: Cory and Erik authored 46 and 20 PRs as software developers (66
  total); Shawn authored 1 as account manager. Another 43 belong to
  `ju-liechen`, whose identity remains unclassified.
- Coincards: Adriaan authored 49 as technical lead; the shared integration
  agent authored 24. No retained September PR openings are attributed to
  Gavin; that says nothing about his work outside this evidence.

Limitations and next refinements:

- Map `ju-liechen` and `gabriolainput` explicitly. A technical lead's PR
  authorship is evidence of implementation
  involvement, not an automatic signal of overload or a role mismatch.
- Resolve Momday's 39 unclassified September emails before interpreting
  customer communication trends. Inspect sender/recipient relationships;
  do not force all synced mail into customer traffic.
- Preserve source gaps: Jointly has no Gmail evidence; Coincards has no Gmail
  or Granola evidence. Momday's latest retained meeting is September 28, so
  October's zero observed meetings cannot establish zero meetings held.
- Jointly/Momday have 26/112 legacy board candidate entries in September.
  They cannot establish distinct drag counts. New operation IDs improve
  future evidence; historical exact counts cannot be reconstructed reliably.
- Momday's October 13 strategist handover passes boundary checks at Vancouver
  midnight, but there are no retained post-handover strategist events in this
  trial to evaluate a change in activity. Compare complete periods later.

All 1,576 event evidence references resolve to retained source files with
matching digests. Independent source-identity tallies match 313/508/121 PRs,
19/39/0 meetings, and 0/308/0 emails across the full retained histories of
Jointly/Momday/Coincards. Repeated extraction produces identical events and
CLI output matches the shared query results. Snapshot freshness is current in
the materialized trial clones.

On the existing host, full rebuilds took 1,162/476/387 ms; median cached query
times over 10 queries were 2/3/<1 ms respectively. These are small-sample local
query timings, not HTTP latency or a concurrency benchmark. No Redis is needed
for these measured workloads. Trial scripts, aggregate JSON and verification
results are retained locally in `.lore/load-trial-20261014/` (gitignored).

Implementation validation: TypeScript build/typecheck and all 400 repository
tests passed, including CLI/MCP equivalence, independent Load publication
without LLM extraction, temporal roles, deduplication, atomic recovery, board
operation grouping, and timezone boundaries.

Email follow-up on October 14: Jointly's Gmail source was absent, rather than
enabled with no matching messages. It is now enabled in the live context for
Shawn, Stephanie, Adriaan, Cory, and Erik's mailboxes, scoped to the configured
Jointly domains/customer contacts. Aimee and Zeeshan's supplied addresses were
already present; Amanda now uses `amanda@jointly.ca`, retaining
`amanda@getjointly.ca` as an alias. The three-month backfill imported 34 unique
emails: 4 sent, 13 received, and 17 unclassified by the current Load rules.
September contains 4 received and 12 unclassified emails. Unclassified senders
include other teammates, vendor contacts, and automated addresses, so they must
not all be relabeled as customer communication. The isolated rerun is saved in
`.lore/load-trial-20261014/jointly-email-followup.json`; the original trial
numbers above describe its earlier input snapshot.

The same live audit found Gmail unconfigured for Coincards, Gym Content Co,
Producer Social Club, Purposely, The Aesthetic Vault, and The Modern Accountant
Club. Paula's departed mailbox caused Momday's Gmail error. At the user's
request, Paula was removed from active contacts in Momday and CareMobi and
excluded from all eight configured Gmail sources. Historical evidence remains
retained. These source configuration changes do not enable live Load itself.

## Semantic activity: decisions, requests, commitments

Three inferred event types are available: `decision.made`, `client.requested`,
and `human.committed`. An explicit choice, customer ask, or personal undertaking
must have verbatim quoted source evidence. A PR merge, implemented feature,
task assignment, proposed option, or mutable decision/request summary is not
itself evidence of those acts. SOW capacity remains a separate concept.

Enable the independent semantic stage alongside the source projection:

```json
"load": {
  "enabled": true,
  "timezone": "America/Vancouver",
  "actors": [],
  "semantic": {
    "enabled": true,
    "from": "2026-10-01",
    "max_batches": 1
  }
}
```

Keep the project's real actor registry in `actors`. `from`/optional `to` scope
the source document dates to inspect, with an exclusive `to`; an explicitly
dated act described in a later recap can have an earlier occurrence date.
Without boundaries, all retained eligible documents are considered.
`sources` can restrict the default Slack, Gmail, Granola, board, GitHub, Jira,
Linear, docs, Figma, and Notion streams. GitHub commit/release/state observations,
Jira state observations and Figma frame/index snapshots are excluded; their
comments and conversational evidence remain eligible.

```sh
lore load extract --max-batches 3
lore load --type decision.made --from 2026-10-01 --to 2026-11-01
lore load events --type client.requested --status accepted --json
lore load events --method inferred --status candidate --json
lore load events --method inferred --undated --json
```

The self-hosted `run-all --extract` executes semantic batches independently of
the ordinary artifact fold and its chatter gate, including when `extract: []`.
The standalone command runs only semantic extraction and does not create or
modify tickets, requests, decisions, or roadmap summaries. Source rebuilds
preserve the semantic ledger and re-resolve roles against current configuration.
Queries never call an LLM.

Each bounded batch contains at most 30,000 source characters/80 chunks, with
long documents split into overlapping chunks. Content digests detect edits,
including same-length replacements. Output schema, source chunk IDs, exact
quotes, duplicate targets, and related IDs are validated before advancing any
checkpoint. The CLI model backend has no tools or MCP servers. Invalid output,
provider failures, and interrupted batches remain pending. Each successful
batch atomically publishes its claims, checkpoints, current projection, and
coverage together in `load.json`; Git reconciliation merges independently
published ledgers and reprocesses conflicting checkpoint revisions.

Accepted semantic events require high model confidence, a known human actor,
source-supported attribution, and a verifiable occurrence date; customer
requests additionally require a customer role. Other proposals remain
candidates. Day-only dates are not fabricated into precise instants. Undated
events are excluded from time-period totals and can be inspected separately.
Timezone overrides preserve a day-only event's original project-local date.

Repeated reports attach evidence to a supplied existing event ID. Exact anchor
replay deduplicates in code. Reversals/materially new acts create related events.
The model receives up to 150 relevant existing claims; semantic matching remains
an evaluated inference and can miss duplicates. Missing/changed source quotes
invalidate projected claims until re-extraction. Every query exposes
`semanticCoverage` (processed/pending chunks, scope, failure state) and separates
source/inferred and accepted/candidate counts. A processed chunk is not proof
that every possible act was found. Manual correction/retraction tooling and a
larger labeled evaluation corpus remain future work.

### Semantic trial and rollout status (2026-10-14)

The sample covered eligible documents dated September 28 in Vancouver across
the same three projects. All 337 eligible chunks were processed. The table
describes proposals from that source slice, not a complete project history:

| Project | Automatically accepted | Candidates | Unknown occurrence dates |
| --- | ---: | ---: | ---: |
| Jointly | 1 | 5 | 0 |
| Momday | 3 | 14 | 0 |
| Coincards | 1 | 25 | 1 |

All 83 quoted references were checked against their retained source documents.
Twelve proposed events attach evidence from more than one source. Replaying
unchanged inputs made no model calls and produced identical events. The
deterministic source events and tracker files were unchanged. Build and all
414 repository tests passed, including failed-batch resume, invalid-quote
retry, date precision, semantic-ledger merging, and workspace-scoped Slack
identity resolution.

Examples include Cory choosing the re-issue path for expired Momday offer
codes, Shawn specifying Coincards' develop/main CI split, and Cory committing
to supply App Store screenshots. A later Momday decision to use plain iPad
screenshots links to the earlier commissioned-design decision as a related
change; both remain candidates. The source review also found uncertain
speaker identities, recaps with initially unknown dates, repeated mentions,
and team-side asks that must not enter accepted customer-request counts.
These are reasons for the conservative candidate queue. This small inspected
sample does not establish precision or recall across all historical activity.

The historical trial used the functioning local Claude session on isolated
copies while the host's OAuth session was expired, without moving credentials.
The user reauthenticated the host on October 14 and a completion under the
service's user and environment succeeded. Results and reproducible checks
are in `.lore/semantic-trial-20261014/`. Slack profile lookups identified
Zeeshan Haider, Brayden, and Mike Olthoff, but their proposed customer identity
mappings are awaiting user confirmation. No identity was silently promoted.

Release `/srv/lore/releases/36560f8-load-20261014` is active and the hosted
service was restarted. Public health and board routes return HTTP 200; MCP
continues to require authentication. The release exposes 20 MCP tools,
including read-only `lore_load`. Load was first enabled in the live Jointly,
Momday, and Coincards repositories, with confirmed actor roles and the
October 13 Momday strategist handover, then expanded to all 14 active projects.
Only each project's `load` block was changed; existing source and contact
settings were preserved.

The applied settings are saved in
`.lore/semantic-trial-20261014/project-load-settings.json`: October 1 onward,
one bounded semantic batch per scheduled extraction. The existing sync timer
invokes the active release with `--extract`; in-flight runs of the previous
release finish normally. Semantic coverage reports the remaining backlog,
last successful extraction and failures. Enabling tracking does not imply
that the October backlog has already been fully processed.

The first live pass succeeded for all three projects using the host's restored
Claude session. Each result was committed and pushed to its live repository;
all projections were current at verification. All 14 evidence quotes matched
the retained source text and digest, with no duplicate event IDs.

| Project | Processed chunks | Pending chunks | Accepted inferred events | Candidates |
| --- | ---: | ---: | ---: | ---: |
| Jointly | 9 | 406 | 0 | 4 |
| Momday | 16 | 553 | 1 | 0 |
| Coincards | 39 | 561 | 0 | 6 |

These are initial bounded-pass results, not complete October activity counts.
Verification reports are saved under
`.lore/semantic-trial-20261014/live-rollout/`. The full implementation suite
passed all 414 tests before release; production CLI queries and service health
checks also passed after activation.

### All-project expansion (2026-10-14)

Load is enabled and initial projections are committed in all 14 active host
repositories: Aliviado Caregiving, Aliviado Clinician, CareMobi, Coincards,
DeleteMe, Gym Content Co, Jointly, Merrin, Momday, Owlos, Producer Social Club,
Purposely, The Aesthetic Vault, and The Modern Accountant Club. The 11 newly
enabled projects use America/Vancouver, semantic evidence from October 1,
and one semantic batch per scheduled extraction. Existing settings for the
original three projects are preserved.

Confirmed person/GitHub identities and known agent identities are reused
without copying project-specific roles. New projects retain unknown team roles
until confirmed; configured client-side contacts supply the customer role.
Source integrations were not added or changed. Unavailable sources remain
explicit gaps, and shared source material can appear in multiple projects,
so project counts must not be summed as unique agency-wide activity.

All 14 projections built and passed query/schema and unique-event-ID checks.
Expansion reports are in `.lore/semantic-trial-20261014/all-projects/report.json`.
At rollout, the host Claude session reported a usage limit. After the user
upgraded the seat, a host completion succeeded and the all-project run was
started again on October 14. A live Owlos extraction processed all six pending
chunks, publishing two candidate events with four verified quotes. The
all-project run also reached CareMobi semantic extraction. Existing checkpoints
and the one-batch-per-project limit are preserved; completion of the broader
backlog is still pending. Deterministic counts remain available throughout.

The sections below retain the broader design and roadmap. Additional semantic
categories, Figma/deployment adapters, corrections, cross-project rollups, and ordinary
fold change-detection migration are not part of this implementation.

### Jev filtering and token measurements (2026-10-15)

The active release is `/srv/lore/releases/36560f8-load-jev-20261015`.
All 14 projects use `load.semantic.gate: {"mode":"filter","threshold":0.3}`.
Modes are `off`, `shadow` (classify and measure without skipping Claude), and
`filter`. When the gate setting is absent, Load behaves as before.

Jev scores each passage for decisions, requests and commitments. Request
classification deliberately does not guess customer roles. Claude still resolves
project identities, dates, quoted evidence and duplicate events. Entire passages
are retained when any score reaches the threshold; long documents bypass
negative filtering. Missing credentials, invalid answers and provider failures
retain evidence for Claude. A fully negative batch avoids the Claude call.

Classification results are cached across projects by source content/metadata,
model alias and classifier version in `/srv/lore/cache/load-jev`. Entries expire
after 30 days; only scores and hashes are stored there. The provider exposes
`jev-latest` and `jev-preview`, so the model key is an alias, not an immutable
provider revision. `LORE_LOAD_JEV_MODEL` overrides that alias. Skipped chunks
have distinct checkpoints incorporating the classifier version, model alias
and threshold. Disabling the gate or changing its policy makes those chunks
pending again. Coverage exposes `screened` separately and warns when material
was screened without Claude extraction. Existing extracted events are retained.

Historical evaluation covered 2,898 chunks and 374 retained semantic events
across all projects. At 0.3, the proposed skips were 246 chunks (8.5%) and
145,699 of 2,973,370 source characters (4.9%). Every retained event still had
supporting evidence. An additional Claude review of 92 proposed-skip chunks
from Jointly, Momday and Coincards produced zero event proposals. This is
retrospective evidence, not a guarantee of recall on future conversations;
the retained corpus is not independently labeled ground truth.

The historical screen used 2,522,943 Jev input tokens and reused 125 cached
classifications. Jev adds its own token usage: the objective is reduced Claude
usage, not fewer total tokens across both providers. Source-character savings
are not measured total Claude-token savings. Successful batches now record
Claude input/output/cache-read/cache-write usage, Jev input usage, cache hits,
skips and shadow misses in `/srv/lore/cache/load-metrics/usage.jsonl` (rotated
at 5 MiB). Failed provider calls are not a complete billing ledger.

Prompt compaction retains the existing event catalog but sends its fields as
rows with one column header, and merges duplicate person/contact identities
while preserving explicit project roles. A representative Jointly prompt fell
from 81,989 to 79,142 characters (3.5%) without dropping catalog entries.
Historical catalogs were kept intact to avoid trading duplicate matching for
unmeasured savings.

The ordinary artifact-fold gate was removed on October 15 after remaining
disabled on lore-host. Its original September
23 commit (`d58281d`) documented only about 0.6% skips. The new October replay
covered 240 eligible folds: 166 changed artifacts or work; at 0.3 only three
would be skipped (1.25%), with zero missed recorded changes. At 0.5, five would
be skipped but one real change lost; at 0.7, fourteen would be skipped and six
changes lost. All three safe skips were Owlos; this small sample does not
justify the extra classification step. DeleteMe required a longer evaluation
timeout. The replay results are retained as historical evidence; the replay
command and ordinary-gate settings have also been removed. Load screening and
PR matching continue to use the shared Jev client.

Reports are stored in `.lore/jev-eval-20261015/`. All 421 tests passed, plus a
host runtime check proving a cached negative passage makes no Claude call and
preserves existing events. Ordinary-fold same-length change detection remains
a separate limitation; this Load gate uses content digests.

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
4. `extract` detects changed stream files, then
   folds whole changed files into requests, decisions, roadmap, and work
   proposals (`src/commands/extract.ts`). Artifact deltas merge by ID.

The following affect the accuracy of Load:

| Finding | Consequence | Required treatment |
| --- | --- | --- |
| Semantic extraction only emits selected event types. | Ordinary emails, meetings, and PR activity would be undercounted if counted only by the LLM. | Run deterministic activity extraction independently; give semantic Load its own completion tracking. |
| Change detection compares only string length, while GitHub Projects replaces entries (`streams.ts`). | A same-length update is invisible to extraction; intermediate same-day snapshots are overwritten. | Use content digests for changed-file detection and persist distinct source revisions going forward. Digests alone cannot recover overwritten history. |
| Changed day files are folded in full; retries and split-file recovery can repeat material. | Incrementing counters per batch would double count. | Upsert canonical events by stable identity, then aggregate. |
| Source-document deduplication is normally per day file, not global. | A source ID can recur under a different date/channel. | Deduplicate Load by source identity independently of its storage path. |
| `via` identifies an interface, not human versus agent execution. CLI/MCP can record an OS or server-attested identity. | Calling every CLI/MCP action human would inflate human counts. | Retain execution identity, represented/authorizing identity where available, actor kind, and attribution evidence; leave unresolved identities unknown. |
| Lore work changes live in ticket history, not generally in streams. | A stream-only Load pass would miss board moves and assignments. | Scan work history independently, even when there are no new stream files. |
| External tracker snapshots and sync history describe observations, not complete source transitions or their actors. | An imported assignment is not necessarily a new assignment at sync time. | Treat first observations as baselines; label uncertain transition times and do not assert human actors. |
| Requests/decisions are mutable summaries; there is no operational-commitment artifact. | Counting current rows or their updates cannot reliably count historical acts. | Record evidence-backed occurrences, linking to artifacts where appropriate. |

Confirmed locally: replacing a GitHub Project entry's `status: todo` with
`status: done` changes its content but preserves length, so the current fold
does not detect the change. Load now uses content digests independently; the
ordinary fold's change detection still needs its own migration.

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
| Work items completed | `ticket.completed`: first recorded transition into `done` per non-archived Lore item | Count once across retained history, preserving recording surface and actor. Exclude creation, archival, and repeat completion after reopening; missing dates remain undated candidates. |
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

Keep text in Git. The initial implementation uses the atomic JSON envelope
described above. A later storage version may add monthly event partitions under
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
  observed_at?: string       // first observed by Lore, when retained; not the counting date
  actor: {
    id?: string
    kind: 'human' | 'agent' | 'service' | 'unknown'
    roles: Array<'customer' | 'account_manager' | 'client_strategist' |
      'technical_lead' | 'software_developer' | 'designer'>
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

For source events, derive IDs from a stable source namespace + canonical entity
+ native occurrence ID. Keep IDs independent of derived classification: an email
retains its ID when new role evidence resolves its direction. For new Lore
history entries, persist an immutable mutation ID and initial
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

## Broader semantic fold roadmap and recovery

Deterministic Load runs after sync; the independent semantic stage described
above runs in the scheduled extraction phase, with its checkpoints in the
projection envelope. The following preserves the broader integration proposal;
embedding semantic proposals into the ordinary artifact fold remains deferred.

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

`lore load` and the read-only `lore_load` MCP tool use one shared query
implementation. Available examples:

```sh
lore load --from 2026-09-01 --to 2026-10-01 --tz America/Vancouver --group-by type
lore load --from 2026-09-01 --to 2026-10-01 --type pr.created --group-by actor-kind
lore load --from 2026-09-01 --to 2026-10-01 --group-by week --json
lore load events --type pr.created --from 2026-09-01 --to 2026-10-01
```

Use half-open ranges `[from, to)`. Date-only boundaries are interpreted in the
explicit/project timezone, with a documented UTC fallback. Bucket by local
calendar day/week/month, including daylight-saving changes. Store day-precision
evidence as a date with timezone context rather than inventing an exact instant;
exclude it from finer-grained queries or report it as boundary-uncertain.

Return counts by type with source/inferred splits, actor/role filters, accepted
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

1. **Foundation and source counts — implemented:** schema/parser/store, digest checkpoints,
   identity mapping, PR/email/meeting counts, known human board moves,
   query/MCP surfaces, coverage and isolated backfill. No agent/human inference
   from display names alone.
2. **Semantic activity — first three types implemented:** decisions, client
   requests and human commitments. Technical escalations, interventions,
   incident and QA evidence remain future additions. Add
   cross-source reconciliation and corrections. Use a labeled corpus to
   measure false positives, misses, actor attribution, and duplicate events;
   define acceptance thresholds before claiming semantic coverage.
3. **Better instrumentation:** mutation IDs/creation assignments are implemented;
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

## Project scope review

When a retained semantic claim belongs to another project (for example, a PR
from a shared repository), add a project-local review in
`load.semantic.excluded_events` in `lore.json`:

```json
{
  "id": "load-sem-203b259984d15f71ef3baafd5641970d",
  "reason": "Confirmed by Shawn: $64/month signup pricing belongs to The Aesthetic Vault only.",
  "reviewed_on": "2026-10-15"
}
```

Commit the config and run `lore load rebuild`. Reviewed IDs are omitted from
accepted and candidate counts; `semanticCoverage.excludedEvents` reports how
many retained claims were excluded. Original claims, quotes and checkpoints
remain intact, so ordinary rebuilds, exact-anchor replays and ledger merges
do not resurrect those IDs. Removing a review restores the original assessment.
The extraction prompt also receives the reviews and project-scope guidance;
semantic duplicate matching remains an inference and can still require review
when a model creates a different claim ID. Reviews affect semantic activity
only, not source PR counts. No model call is needed to apply a review.
