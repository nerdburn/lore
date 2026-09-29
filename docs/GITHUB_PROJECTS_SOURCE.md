# GitHub Projects source — design brief

**Status:** implemented locally; release and live validation pending
**Target release:** 0.5.0
**Author of the design:** captured with Shawn 2026-09-29 (Claude Code session on `enso-agent-bootstrap`)
**Reason for the feature:** on 2026-09-28 midas (Coincards agent) failed to add a new issue to org Project #8 because the exe.dev `github.int.exe.xyz` aggregate proxy rejects org-level GraphQL (`document does not identify a repository`). The workaround was a per-VM PAT. This design promotes GitHub Projects to a first-class lore source so agents call lore instead of `gh project`, keep one credential on `lore-host`, and get bidirectional sync into the work tracker. `LORE_GITHUB_TOKEN` is already deployed on `lore-host` with the right permissions (Contents/Issues/PRs Read, Issues Write, org Projects Read+write); every context's `github` source is already using it (see the 2026-09-29 fleet-wide swap).

---

## Implementation notes (0.5.0)

Implemented in this checkout; publishing, host rollout, and live Project #8
validation are separate release steps below.

The following corrections reflect the actual repository and current GitHub schema:

- Existing work rows use `key` and a **single** `external` issue reference, not
  an external list. That reference remains compatible. Project references live
  in an additive `project_items: [{kind, ref, project, url, last_sync}]` list.
- The public `sources.github_projects` array is accepted as shown below. Lore
  normalizes it internally to `{projects: [...]}`; that object form also supports
  `disabled: true`. Each project supports `disabled`, `token: "env:…"`, and an
  optional GraphQL `api_base`. `status_map` is required, without fuzzy defaults.
- Project items support position ordering, not `UPDATED_AT` ordering or a since
  filter. Sync paginates every item, including archived items, then compares
  per-item timestamps and content fingerprints. Linked issue edits and option
  renames are detected even when the item timestamp does not change. Field
  values paginate too; the selected status field is looked up by name.
- `addProjectV2DraftIssue` returns `projectItem`, not `projectV2Item`. Content node
  IDs are kept distinct from project item IDs for draft/issue/PR edits. Item URL
  IDs use `fullDatabaseId`.
- Streams use one file per day (§4.1), with stable item IDs and replacement of an
  item's earlier entry that day. Current snapshots are in
  `context/projects/github/<owner>-<number>.json` for inspection. Reconciliation
  reads a fresh complete API snapshot before writing; failed or partial reads
  never imply deletion.
- First link: Lore's title/status win; a missing Lore description imports the
  GitHub body. This establishes a baseline without inventing conflicts. Later
  edits use the three-way field comparison below. `review` is now a work status
  across the tracker, MCP, CLI, fold, and board.
- GitHub and git have no shared transaction. Successful fields advance their
  ledger individually; failed fields retain the pending local value and retry on
  sync. An add persists the returned item ID before setting fields. If interrupted,
  retry with the reported `link_work` to reuse the created draft. Source health
  reports reconciliation failures. Concurrent tracker writes are detected before
  saving, so a reconciliation cannot overwrite newer work.
- Confirmed with Shawn: assignees are read-only metadata; removing an item only
  unlinks it and keeps the Lore row; new items are drafts unless an existing
  GitHub issue is linked. No issue-promotion tool is introduced in this release.
- `lore source list` and `lore check` understand Projects. Configure mappings in
  `lore.json`; `lore source add` deliberately asks for that explicit configuration.

API references: [GitHub Projects GraphQL schema](https://docs.github.com/en/graphql/reference/projects)
and [GitHub's Projects API guide](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects).

The original design below is retained as the handoff record; these notes take
precedence where it assumed an older work schema or unsupported API behavior.

## 1. Goal

Add a `github_projects` source alongside the existing `github` (issues/PRs) source, so lore:

- **Reads** Project v2 items into `context/streams/github-projects/…` — one file per item, keyed by item node id, updated when GitHub reports a change.
- **Auto-links** each project item to an existing lore work row when its linked issue is one lore already tracks. The link is stored as an `external` reference on the work row (loose link — lore's `<PREFIX>-N` ids stay stable).
- **Writes back** status column moves, title edits, and body edits from lore → GitHub Projects when a lore work row changes. Lore is the tracker of record; the project board is a projection.
- **Resolves conflicts** by letting lore always win when both sides changed since the last sync, and logging the drift in `state.json`.

Agents (e.g. midas) call lore's MCP tools to add project items and move columns instead of shelling out to `gh project` through a proxy they can't reach.

## 2. Design decisions

Locked with Shawn on 2026-09-29:

| Decision | Choice | Alternative rejected |
| --- | --- | --- |
| Work-row model | **Loose link** — lore keeps its own `<PREFIX>-N`; project item stored in `work.<row>.external` | 1:1 mirror (project item IS the work row). Rejected: loses lore's independent ticket numbering. |
| Write direction | **Bidirectional for status, title, body**. Item-add and column-move via lore's MCP tools. | Read-only (rejected: doesn't unblock midas). Close-only (rejected: doesn't cover the "edit description" case). |
| Conflict rule | **Lore wins on conflict**, drift entry appended to `state.json` under `conflicts[]`. | Last-writer-wins timestamps (rejected: drifts unpredictably). Never-overwrite (rejected: too much human toil). |
| Column ↔ status mapping | **Explicit per-context in `lore.json`** | Auto-derived from GitHub Status field options with fuzzy match (rejected: too much magic). |

## 3. Configuration

Extend `lore.json`:

```json
{
  "sources": {
    "github_projects": [
      {
        "owner": "inputlogic",
        "number": 8,
        "status_field": "Status",
        "status_map": {
          "Todo": "todo",
          "In Progress": "in_progress",
          "In Review": "review",
          "Done": "done"
        }
      }
    ]
  }
}
```

- `owner` — org login (or user login for personal projects).
- `number` — project number, as in `github.com/orgs/<owner>/projects/<number>`.
- `status_field` — the single-select field name that maps to lore's `status`. Default `"Status"`. (Reads other single-select fields into the stream as metadata but does not map them.)
- `status_map` — bidirectional map from GitHub column name → lore work status. Both keys and values must be unique. Missing GitHub columns are stored on the stream item as `status_raw` and left un-mapped in the work row; on write-back, missing lore statuses fail loud with a config error.

Multiple projects per context are allowed (the field is an array). Item ids are unique across projects, so there's no key collision.

## 4. Data on disk

### 4.1 Streams

`context/streams/github-projects/<owner>-<number>/<yyyy-mm-dd>.md` — one file per day of changes, matching the existing per-source convention. Each item in the day file is a fenced block:

```
---
project: inputlogic/8
item_node_id: PVTI_lADOAEZn3c4BUvQBzgQ_hxk
number: 42                        # project item number (visible in the UI URL)
title: "Fundstream retry can stall when an order has two multi-batch items"
status: In Progress               # raw column name (unmapped)
assignees: [adriaanwm]
linked_issue: inputlogic/backoffice-coincards#117
url: https://github.com/orgs/inputlogic/projects/8/views/1?pane=issue&itemId=…
updated_at: 2026-09-29T14:12:03Z
---
<body markdown>
```

### 4.2 Cursor

`state.json.cursors.github_projects["<owner>/<number>"] = {since: ISO, item_updated_ats: {node_id: ISO}}` — a per-item high-water mark so a re-run only pulls items whose `updatedAt` moved.

### 4.3 Work row extension

`context/work/lore/<PREFIX>.yaml` grows an optional field on each item:

```yaml
- id: COI-14
  title: "Run the controlled UK production test purchase through Runa"
  status: done
  external:
    - kind: github-issue
      ref: inputlogic/backoffice-coincards#82
    - kind: github-project-item
      ref: PVTI_lADOAEZn3c4BUvQBzgQ_hxk
      project: inputlogic/8
      last_sync:
        status: done
        title: "Run the controlled UK production test purchase through Runa"
        body_hash: 3f0e9…             # sha256 of last synced body
```

`last_sync` is the reconcile ledger — the values lore believes are on both sides after the last successful reconcile. Conflict detection is `current_project != last_sync && current_lore != last_sync`.

`external` is already a list on work rows (existing shape for github-issue and jira links); this just adds a new `kind`.

## 5. Data flow

### 5.1 Sync (read) — every `lore run-all`

1. For each configured project, fetch items updated since the cursor via GraphQL `projectV2.items(first: 100, after: <cursor>, orderBy: {field: UPDATED_AT, direction: ASC})`.
2. For each item: write/overwrite its entry in today's stream file. Update `item_updated_ats[node_id]`.
3. **Auto-link pass**: for each item with a `linked_issue` that maps to a lore work row (matched via the existing github-issue `external` ref), ensure that row has a matching `github-project-item` `external` entry. If missing, add it with an empty `last_sync` — reconcile will fill it on the next step.
4. Hand off to reconcile.

### 5.2 Reconcile (write-back) — after sync, and on every `lore_work_*` write

For each work row with a `github-project-item` external:

1. Load the project item's current `{status_raw, title, body}` (from the just-synced stream) and its lore counterpart `{status, title, description}`.
2. Compare each field against `last_sync`:
   - Neither changed → no-op.
   - Only project changed → apply to lore work row. Update `last_sync`.
   - Only lore changed → apply to project item via GraphQL mutation (`updateProjectV2ItemFieldValue` for status; `updateProjectV2DraftIssue` or issue updates for title/body when the item is a linked issue). Update `last_sync`.
   - Both changed → **lore wins**. Overwrite project side with lore's value. Append to `state.conflicts[]`: `{at, kind: "field-drift", project, item_node_id, field, lore_value, project_value, resolved: "lore"}`. Update `last_sync` to lore's value.
3. Body-hash caveat: `body` on GitHub is often long and reformatted server-side (whitespace, checkbox state). Hash after a normalisation pass (trim trailing whitespace per line, collapse blank runs) to avoid false-positive drift.

Fold changes to work rows (`applyFoldChanges` in `src/work.ts`) count as "lore changed" for reconcile — the fold's move triggers a push to the project.

### 5.3 Item-add / column-move via MCP

New tools (see §6) mutate the project **and** the lore work row in one call, then write `last_sync` so reconcile sees them as in-agreement.

## 6. New / extended MCP tools

Add to `src/commands/mcp.ts`:

- `lore_project_item_add`
  - Args: `{project: "owner/number", title: string, body?: string, status?: string, link_work?: "<PREFIX>-N"}`.
  - Behaviour: creates a draft item on the project (or an existing issue's project entry when `link_work` names a work row whose `external` includes a `github-issue`); sets status; links to the named lore work row (creating one if `link_work` is omitted — auto-numbered from the context's prefix).
  - Returns: `{item_node_id, project_url, work_id}`.

- `lore_project_item_move`
  - Args: `{item: "<work-id>" | "<project-item-node-id>", status: string}`.
  - Behaviour: sets the single-select Status field on the project item and the corresponding lore work row's status in one atomic update. Reconcile updates `last_sync` accordingly.

- Extend `lore_work_add`: accept `project?: {owner, number, column?}` — creates the project item alongside the work row.
- Extend `lore_work_move`: when a moved row has a `github-project-item` external, reconcile fires immediately (not on next `run-all`).

Every write logs an entry to the row's `history` (`who, when, surface, why, evidence`) — existing convention in `src/work.ts`.

## 7. Code touch points

- `src/connectors/github-projects.ts` — **new**, alongside `src/connectors/github.ts`. Owns GraphQL calls for reading and writing project items.
- `src/config.ts` — extend `LoreConfig.sources` schema with `github_projects: GhProjectConfig[]`.
- `src/state.ts` — extend cursor shape; add `conflicts[]` array.
- `src/streams.ts` — nothing special (per-day markdown files match existing pattern).
- `src/work.ts`:
  - Extend `WorkItem.external` typing for the new `kind`.
  - New `reconcileProjects()` function called at end of `sync` and after `applyFoldChanges` and after each MCP write.
  - `mirrorExternal()` already maps issues → work rows; extend so that a project item linked to a mirrored issue picks up the auto-link without a second pass.
- `src/commands/mcp.ts` — add the two new tools; extend the two existing ones.
- `src/cli.ts` — add `lore project` subcommands (`item add`, `item move`, `sync <owner>/<number>`) for parity with MCP tools; humans debug from the CLI.

## 8. GraphQL cheatsheet (for the implementer)

Read:

```
query ($owner: String!, $number: Int!, $after: String) {
  organization(login: $owner) {
    projectV2(number: $number) {
      id
      title
      fields(first: 20) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } }
      items(first: 100, after: $after) {
        pageInfo { endCursor hasNextPage }
        nodes {
          id
          type
          updatedAt
          content {
            ... on Issue { number title body url repository { nameWithOwner } state }
            ... on PullRequest { number title body url repository { nameWithOwner } state }
            ... on DraftIssue { title body }
          }
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue { field { ... on ProjectV2SingleSelectField { name } } name }
              ... on ProjectV2ItemFieldTextValue        { field { ... on ProjectV2FieldCommon        { name } } text }
              ... on ProjectV2ItemFieldDateValue        { field { ... on ProjectV2FieldCommon        { name } } date }
            }
          }
        }
      }
    }
  }
}
```

Write status:

```
mutation($project: ID!, $item: ID!, $field: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field,
    value: { singleSelectOptionId: $optionId }
  }) { projectV2Item { id } }
}
```

Add draft item:

```
mutation($project: ID!, $title: String!, $body: String) {
  addProjectV2DraftIssue(input: { projectId: $project, title: $title, body: $body }) {
    projectV2Item { id }
  }
}
```

Link existing issue:

```
mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) {
    item { id }
  }
}
```

## 9. Migration

- No existing data schema breaks. Work rows without an `external.github-project-item` entry are unaffected.
- Contexts adopting the feature add `sources.github_projects: […]` to their `lore.json`; nothing else changes.
- First sync per project is a full backfill (no cursor). All existing project items become streams; auto-link populates externals for the ones lore already tracks via `github` issues. Existing lore rows without a matching project item stay project-less until an MCP call adds them.
- No local dev token needed on lore-host — `LORE_GITHUB_TOKEN` is already in `/etc/lore/env` with `Organization → Projects: Read and write`.

## 10. Release

- Version bump: `0.4.x` → `0.5.0`.
- Publish `@nerdburn/lore@0.5.0` to npm.
- Update lore-host: `sudo npm install -g @nerdburn/lore@0.5.0`, then `sudo systemctl restart lore-www` (MCP endpoint). Rerun a `lore-sync-now` to seed the first project sync for contexts that adopt the source.
- For Coincards specifically: after the release lands, add `sources.github_projects` to `lore-coincards/lore.json` with `{owner:"inputlogic", number:8}`, sync, verify auto-link populates COI-* rows with `github-project-item` externals, then drop the "add to Project #8 by hand" note from `backoffice-coincards/CLAUDE.md` and replace it with "lore keeps Project #8 in sync — call `lore_project_item_add` (or let a lore work-row add auto-project)".

## 11. Test plan

Unit-level (in `test/`):
- Auto-link matches a project item's `linked_issue` to the right work row when `github` source has already mirrored the issue.
- Reconcile field-comparison correctly identifies each of the four outcomes (neither, only-project, only-lore, both).
- Conflict entries land in `state.conflicts[]` with the right shape.
- Body hash is stable across whitespace normalisation and unstable across meaningful edits.
- `status_map` misses (raw column name not in the map) surface as an error on write-back but a `status_raw` fallback on read.

Integration (against `inputlogic/8`, backoffice-coincards):
- Add a draft item via `lore_project_item_add`, confirm the project shows it, confirm a matching work row exists.
- Move it via `lore_project_item_move`, confirm both sides.
- Edit title on the project side, run `lore-sync-now`, confirm lore's row updated.
- Edit body on both sides between syncs, confirm lore wins and a conflict is logged.

## 12. Open questions for the implementer

Confirm with Shawn before merging:

1. **Assignees**: should assignee list on the project item map to a lore work-row field (`owner` / `assignees`), or is it read-only metadata for now? (Current work rows have a `who` on history entries but no primary assignee field.)
2. **Project item deletion**: if a project item is removed from the board, do we keep the lore work row and drop only the `external.github-project-item` (my default), or close the row too?
3. **Draft vs issue**: `lore_project_item_add` defaults to creating a **draft issue** on the project. If the caller wants a real repository issue instead, do they set that up-front (`{repo: "owner/name"}` on the call) or is a subsequent `lore_work_promote_to_issue` fine?
4. **Multi-org PATs**: this design assumes one `LORE_GITHUB_TOKEN` covers every project referenced by any context. If we ever host a context whose project lives under a different org, we'll need `token: env:LORE_GITHUB_TOKEN_ACME` per source. Not urgent; note it in code so we know where to wire it.

---

*Handoff:* a fresh agent session can start from this file. Everything in §2 is locked; §12 needs a quick confirmation from Shawn before the writes are wired. The existing `src/connectors/github.ts` is the closest reference for the read half. The existing `src/work.ts` is the closest reference for the write half.
