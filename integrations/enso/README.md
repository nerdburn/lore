# lore ↔ enso

Run lore tickets through an [enso](https://github.com/nerdburn/enso) project:
one enso task per ticket, each stage change written back to the ticket, and
never two runs of the same ticket at once.

`lore_bridge.py` has no model in it. It needs the `lore` and `enso` CLIs on
the machine that runs enso, lore with `lore work claim --next-for`, and
enso ≥ the release with `enso task add --unique-ref`.

## How a ticket flows

1. Someone (a person on the board, or the PM agent) assigns a `todo` ticket
   to the agent's name (`LORE_ASSIGNEE`).
2. When capacity opens, `dispatch` claims the first eligible assigned ticket in Lore rank order, creates the enso task with
   `--unique-ref lore:<KEY>`, and records the task ref and stage on the claim.
3. enso runs its stages. After every move the `transition` hook updates the
   ticket's stage and status; a block also leaves the reason as a comment.
4. `done` releases the claim and closes the ticket; `cancelled` releases it.

Each `dispatch` run also renews the runner's claims (its heartbeat — lore
emails the account lead about a claim that has been silent for six hours),
repairs anything a missed hook left behind, and drops the enso task of a
ticket a person closed in lore.

By default the runner gives its current ticket the available slot through
build, review, and blocking. A claim in the Enso backlog also occupies a
slot. Assigned work already in progress in Lore counts even if it has no
claim. Set `LORE_MAX_IN_FLIGHT` for a runner that can actually work several
tickets in parallel. `LORE_MAX_NEW` still limits starts per dispatcher pass.
The claim checks capacity and rank again on a competing push. Existing runs
continue to receive their heartbeats and stage updates.

## Setup

Settings live in one small file beside the script (`lore-bridge.env.sh`):

```sh
export LORE_PROJECT=acme
export LORE_HOLDER=enso:athena
export LORE_ASSIGNEE=athena
export ENSO_PROJECT=WEB
```

A command job that runs the dispatcher (`jobs/lore-dispatch/JOB.md`):

```markdown
---
name: Lore dispatch
schedule: "*/3 * * * *"
enabled: true
command: bash -c '. /path/to/lore-bridge.env.sh && python3 /path/to/lore_bridge.py dispatch'
timeout: 240
---
Start lore tickets assigned to the agent and keep claims in step with enso.
```

The project hook (`PROJECT.md`):

```yaml
hooks:
  after_transition: bash -c '. /path/to/lore-bridge.env.sh && python3 /path/to/lore_bridge.py transition'
```

See the docstring in `lore_bridge.py` for every setting, including
`LORE_STATUS_MAP` when the project's stage names differ from
build / review / qa / merge / deploy.

## What refuses a duplicate

- `lore work claim` exits 3 when another holder — or the same holder under a
  different task ref — has the ticket. Nothing is written.
- `enso task add --unique-ref` creates nothing when an unfinished task
  already carries `lore:<KEY>`; the dispatcher adopts that task instead.
- A claim never expires by itself. Freeing a ticket whose runner is gone is
  a person's call: `lore work release <KEY> --force --reason "…"`.
