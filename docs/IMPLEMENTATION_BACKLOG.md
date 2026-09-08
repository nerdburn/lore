# Lore implementation backlog

## Product goal

Lore is a client-scoped project-memory MCP service. An agent should be able to
ask questions such as:

- What are this client's current priorities?
- What requests are outstanding?
- What issues has this client been experiencing?
- What work has happened recently?
- What decisions, risks, and next steps should we know about?

Answers must be specific to a selected client/project, cite their evidence,
and state when the relevant sources were last synchronized.

Lore will collect from Slack, GitHub, Granola, and later Jira. A client may
have multiple projects, channels, repositories, and source scopes.

## Architectural decisions

### Context and tenancy

Use one private Lore context repository per client by default. The Lore
application itself remains in this repository; each client gets its own
private, access-controlled data repository. Do not use a client's code
repository as the Lore data store.

The source systems remain the source of record. Lore stores an attributable,
queryable sync of source material plus derived summaries and explicitly
confirmed facts.

### Work tracking is optional

Each project can have a canonical work tracker, but it is not required.

- `github`: GitHub Issues is authoritative for issue state, priority,
  assignee, milestones, and completion.
- `jira`: Jira is authoritative for those delivery fields.
- `none`: Lore maintains a human-confirmed work list based on sourced requests,
  decisions, Slack, and meeting notes.

When no canonical tracker exists, extraction can create *candidate requests*,
but it must not silently assert that work is committed, prioritized, or done.
An authorized user or agent must explicitly promote a candidate to a
Lore-managed work item or change its status. Each such change must record who
made it, when, and the supporting rationale or source.

### Search and storage

Keep raw synchronized documents, human-confirmed facts, and source links as
durable records. Begin with metadata filtering and full-text search. Add
embeddings/vector search only after real queries demonstrate that exact and
full-text retrieval are insufficient. Vectors are a rebuildable retrieval
index, never the source of truth.

Git-backed context repos are appropriate for the first phase because they are
auditable and isolate clients. Introduce managed Postgres plus object storage
only when remote MCP access, larger transcript volumes, near-real-time sync,
or centralized permission enforcement requires it.

## Priority 0: make the existing MVP trustworthy

### 1. Fix MCP recall

**Problem:** The MCP server describes `lore_recall` as returning pins and
derived artifacts, but it currently returns only `context/facts.yaml`.

**Work:** Update `lore_recall` to return pinned facts plus the relevant derived
requests, decisions, roadmap items, contradictions, and reports. Support an
optional category filter consistently with the CLI implementation.

**Acceptance criteria:**

- An MCP call with no category returns pins and every derived artifact.
- `category: "requests"` returns derived requests; `category: "decisions"`
  returns derived decisions.
- A fixture test proves MCP output matches the CLI recall surface.

### 2. Fail safely for unsupported source configuration

**Problem:** Configured but unavailable connectors are printed as skipped,
allowing a sync to appear successful while collecting none of a required
source.

**Work:** Make `lore check` fail for every configured unsupported source. Make
`lore sync` return a non-zero exit status unless a source is explicitly marked
disabled. Include source health in command output.

**Acceptance criteria:**

- A config containing `github` before its connector exists fails validation.
- CI and GitHub Actions fail visibly rather than committing a partial sync.
- Operators can see each source's last successful sync and latest error.

### 3. Add an automated test and CI baseline

**Problem:** The project currently has a build command but no test suite.

**Work:** Add a Node/TypeScript test runner, fixture data, and GitHub Actions
checks. Cover config validation, document writing and deduplication, each
connector, extraction parsing, context resolution, and all MCP tools.

**Acceptance criteria:**

- `npm test` is available locally and in CI.
- Tests require no real source credentials.
- Tests cover a client with Slack, GitHub, and Granola fixture data.

### 4. Harden Slack ingestion

**Problem:** The incremental Slack sync can miss late replies to old threads,
and it does not reconcile edits or deletions.

**Work:** Use an overlap/reconciliation window and track per-thread update
state. Persist Slack workspace ID, channel ID, message timestamp, thread root
timestamp, user ID, permalink, edit state, and deletion state. Continue to
enforce an explicit channel allowlist.

**Acceptance criteria:**

- A reply to an old thread appears after the next sync.
- Rerunning a sync is idempotent.
- Slack records retain stable machine IDs, not only display names.

### 5. Implement security controls described by the specification

**Problem:** The specification calls for secret scrubbing and write access
control, but neither is implemented.

**Work:** Redact likely tokens, private keys, passwords, and API secrets before
writing raw documents to git. Authenticate the caller for write operations;
do not trust a caller-supplied `authorized_by` string. Record an audit entry
for every pin or Lore-managed work-item change.

**Acceptance criteria:**

- Fixture secrets never appear in generated stream files.
- Unauthorized callers cannot use `lore_remember` or update Lore-managed work.
- Every approved write has an actor, time, and reason/source.

## Priority 1: model clients, contacts, projects, and source scopes

### 6. Add a first-class client model

**Work:** Add stable client metadata to every context repo:

- `client_id`
- display and legal name
- primary domain
- lifecycle state (`active`, `archived`)
- internal owner/account lead
- created and updated timestamps

**Acceptance criteria:**

- Client IDs are stable even if a client's display name changes.
- Every source, contact, project, source document, and derived item belongs to
  exactly one client.
- MCP queries require a client/project scope when more than one is available.

### 7. Add a client contact/identity model

**Work:** Create a `contacts` collection for client stakeholders, internal
team members, and vendors. A contact supports:

- stable Lore contact ID
- full name and aliases
- one or more email addresses
- Slack user IDs and workspace IDs
- role/title and relationship to the client
- source/provenance and `last_verified_at`
- sensitivity/export policy where necessary

Use email addresses and Slack IDs as matching keys. Names are display fields
and must never be the sole identity key. Support merges and aliases for people
whose name, email address, or Slack display name changes.

**Acceptance criteria:**

- Slack messages resolve to a contact when a known Slack user ID is present.
- Granola attendees resolve by email where possible.
- Ambiguous name matches remain unlinked until confirmed.
- A contact can hold several email addresses and Slack identities.

### 8. Replace generic source config with typed schemas

**Work:** Replace the untyped source map with validated per-source schemas.
Allow multiple projects and multiple scopes per source:

- Slack channel IDs/names
- GitHub organizations and repositories
- Granola workspace, folder, tag, or meeting filters
- Later: Jira site, project keys, boards, and JQL filters

Record which client and project each scope belongs to.

**Acceptance criteria:**

- Invalid source config is rejected before a sync starts.
- One client can link multiple GitHub repositories and Slack channels.
- A source document can always be traced to one client, project, and source
  scope.

## Priority 2: GitHub-first work tracking

### 9. Build the GitHub connector

**Work:** Implement deterministic, incremental ingestion for configured GitHub
repositories. Collect issues, issue comments, pull requests, reviews, commits,
and releases. Preserve repository, number, node ID, SHA, URL, author, state,
labels, assignees, milestones, timestamps, and linked references.

Use a GitHub App or fine-grained token with the smallest required permissions.
Do not use an individual's broad personal token in shared automation.

**Acceptance criteria:**

- A configured repository syncs idempotently and incrementally.
- Closed/reopened issues and merged/closed pull requests reconcile correctly.
- A GitHub issue and its comments have stable IDs and permalinks.
- Source failures are rate-limit aware, resumable, and visible in health output.

### 10. Make GitHub Issues canonical when selected

**Work:** When `work_tracking.system` is `github`, use GitHub Issues as the
authoritative record for outstanding work. Map state, labels, milestone,
assignees, project fields where available, and linked pull requests/commits.
Do not let the LLM override those fields.

**Acceptance criteria:**

- “What is outstanding?” returns open GitHub issues in the configured scope.
- “What is in progress?” follows the project’s configured labels/project-field
  mapping, not an LLM guess.
- Pull requests and commits are linked as delivery evidence.
- Slack/Granola requests can link to an existing GitHub issue.

### 11. Support projects with no canonical tracker

**Work:** Add `work_tracking.system: "none"`. In this mode, support
Lore-managed work items with explicit human/authorized-agent confirmation.

Fields should include stable ID, title, description, status, priority, owner,
next step, created/reviewed timestamps, sources, actor, and change history.
Suggested statuses are `candidate`, `triaged`, `acknowledged`, `planned`,
`in_progress`, `done`, `declined`, `needs_review`, and `stale`.

**Acceptance criteria:**

- Extraction creates candidates only, with evidence and confidence.
- Promotion to a tracked work item is an explicit audited operation.
- Old, unreviewed work becomes `needs_review` or `stale`, never silently
  presented as active.
- A later GitHub or Jira ticket can attach to the same Lore item without
  duplicating it.

## Priority 3: add meeting intelligence

### 12. Build the Granola connector

**Work:** Sync meeting notes, AI summaries, transcripts, dates, participants,
and source URLs from configured Granola scopes. Associate meetings with clients
and projects using folder/tag configuration plus contact matching.

Meeting-derived requests and decisions are evidence, not automatically
authoritative work or facts.

**Acceptance criteria:**

- Granola notes sync incrementally with stable meeting IDs.
- Matching attendee emails resolve to contacts when unambiguous.
- Agent answers can cite the exact meeting and transcript material.
- A meeting can produce a candidate request or decision with confidence and
  supporting citations.

## Priority 4: improve the knowledge model and extraction

### 13. Normalize source and derived entities

**Work:** Introduce typed entities for `SourceDocument`, `WorkItem`,
`Request`, `RoadmapItem`, `Decision`, `RiskOrBlocker`, `Contact`, and `Project`.
Each must have a stable ID, client/project scope, timestamps, source links,
confidence where derived, and audit history.

Support multiple evidence links. A single source URL is insufficient for an
item derived from a Slack discussion, a meeting, and a GitHub issue.

**Acceptance criteria:**

- Derived items hold multiple source references and external IDs.
- An agent can retrieve an item and every piece of supporting evidence.
- The schema distinguishes source-owned fields from Lore-managed fields.

### 14. Make extraction source-aware and conservative

**Work:** Update extraction prompts and schemas to understand source type,
client/project scope, canonical tracker mode, and contact identities. Preserve
stable identifiers, track provenance, and surface uncertainty.

**Acceptance criteria:**

- GitHub-owned delivery state is never overwritten by an extraction result.
- Weak evidence produces a candidate or low-confidence item.
- Every answer and derived item can be traced to source documents.
- Re-running extraction causes minimal, reviewable churn.

## Priority 5: expose a useful MCP experience

### 15. Add high-level, client-scoped MCP tools

**Work:** Keep low-level `grep`, `read`, `recall`, and `remember` tools. Add:

- `lore_list_clients`
- `lore_client_status(client, project?)`
- `lore_search(client, query, filters?)`
- `lore_get_item(client, id)`

`lore_client_status` should return current priorities, open/stale requests,
active work, blockers, risks, recent GitHub activity, recent meetings,
decisions, source freshness, and citations.

**Acceptance criteria:**

- Every query is scoped to a client and optionally project.
- Every high-level answer includes citations and source freshness.
- Agents can answer the core product questions without manually assembling
several grep calls.

### 16. Prepare for remote MCP, without requiring it immediately

**Work:** Keep stdio MCP for local agents that can execute Lore and access the
client context repo. Design an authenticated remote MCP service for hosted
agents that cannot safely clone every client's repository.

Remote MCP must enforce client-scoped authorization server-side. Git access on
an agent host is not a sufficient long-term permission boundary.

**Acceptance criteria:**

- Local stdio MCP remains supported.
- Remote MCP design includes authentication, authorization, audit logging, and
  client/project scope enforcement.
- A hosted agent cannot enumerate or query an unauthorized client.

## Priority 6: search, operations, and scale

### 17. Add metadata and full-text search

**Work:** Index source documents and derived records by client, project, source,
repository/channel, contact, date, status, and external ID. Use full-text
search before embeddings.

**Acceptance criteria:**

- Queries can filter by source, project, channel/repository, author/contact,
date range, and work status.
- Search results contain enough context and citations to verify an answer.
- Indexes are rebuildable from durable source records.

### 18. Evaluate hybrid/vector retrieval from real usage

**Work:** Collect a representative question set from real client work. Measure
where metadata and full-text search fail. Add per-client, metadata-filtered
embeddings only when semantic recall improves those failures.

**Acceptance criteria:**

- A documented evaluation demonstrates a meaningful retrieval improvement.
- Vector retrieval always filters by authorized client/project before ranking.
- Citations still point to raw source evidence, not vector chunks alone.

### 19. Improve operational safety

**Work:** Add source health reporting, retries, rate-limit handling, resumable
cursor state, error records, sync metrics, retention/deletion workflows,
encrypted credential storage, and read/write audit logs.

**Acceptance criteria:**

- Operators can identify failed or stale sources per client.
- A failed sync resumes without data loss or duplication.
- Client deletion/retention requests can be fulfilled and audited.

## Suggested implementation sequence

1. Priority 0: make current Slack + MCP behavior correct, testable, and safe.
2. Priority 1: ship client/contact/project/source-scope data model.
3. Priority 2: ship GitHub connector and GitHub-canonical work tracking for
   the first customer, plus the `none` tracker mode.
4. Priority 3: ship Granola and contact matching.
5. Priority 4 and 5: normalize derived entities and deliver client-status MCP
   tools with reliable citations.
6. Priority 6: add full-text search, then evaluate hybrid/vector search.
7. Add Jira only when a client needs it, using the same work-item abstraction
   already used by GitHub and Lore-managed projects.
