#!/usr/bin/env python3
"""Run lore tickets through an enso project, one enso task per ticket.

Two entry points, both model-free:

  lore_bridge.py dispatch     scheduled (an enso command job): heartbeat, start
                              tickets assigned to the agent, reconcile the rest
  lore_bridge.py transition   enso project hook `after_transition`: write each
                              stage change back to the ticket

A ticket is never run twice at once. Two guards, either of which is enough:
lore gives a ticket one claim (`lore work claim` exits 3 when it is held), and
enso refuses a second unfinished task for the ticket
(`enso task add --unique-ref lore:<KEY>`).

Configuration (environment):
  LORE_PROJECT    lore project name (`lore -p`)                      required
  LORE_HOLDER     the name this runner claims under, e.g. enso:athena required
  LORE_ASSIGNEE   tickets assigned to this name are started           dispatch
  ENSO_PROJECT    enso project key new tasks go to                    dispatch
  ENSO_WORKSPACE  enso workspace (enso sets it for jobs and hooks)    required
  LORE_MAX_NEW    most tickets to start per run (default 3)
  LORE_STATUS_MAP JSON {"<enso stage>": "<lore status>"} overriding the defaults
  LORE_BIN / ENSO_BIN  executables (default: lore / enso)

Standard library only; python3 3.9+.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

FINISHED = ("done", "cancelled")
STATUS = {"backlog": "todo", "blocked": "blocked", "build": "in_progress", "review": "review", "qa": "review", "merge": "review", "deploy": "review"}
HELD = 3  # `lore work claim` / `release`: someone else holds the ticket


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if not value:
        sys.exit(f"lore_bridge: set {name}")
    return value


def run(cmd: list[str], stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, input=stdin, capture_output=True, text=True)


def last_json(text: str):
    for line in reversed(text.strip().splitlines()):
        try:
            return json.loads(line)
        except ValueError:
            continue
    try:
        return json.loads(text)
    except ValueError:
        return None


def lore(*args: str, ok: tuple[int, ...] = (0,)) -> tuple[int, object]:
    proc = run([os.environ.get("LORE_BIN", "lore"), *args, "-p", env("LORE_PROJECT")])
    if proc.returncode not in ok:
        raise RuntimeError(f"lore {' '.join(args[:3])}: {proc.stderr.strip() or proc.stdout.strip()}")
    return proc.returncode, last_json(proc.stdout)


def enso(*args: str, stdin: str | None = None) -> tuple[int, object, str]:
    proc = run([os.environ.get("ENSO_BIN", "enso"), *args, "--workspace", env("ENSO_WORKSPACE"), "--json"], stdin)
    return proc.returncode, last_json(proc.stdout), proc.stderr.strip() or proc.stdout.strip()


def status_for(stage: str) -> str:
    table = {**STATUS, **json.loads(os.environ.get("LORE_STATUS_MAP", "{}"))}
    return table.get(stage, "in_progress")


def lore_key(task: dict) -> str | None:
    for ref in task.get("refs") or []:
        if ref.get("kind") == "lore":
            return str(ref.get("value"))
    return None


def claim(key: str, **fields: str | None) -> bool:
    """Take or confirm the claim; False when someone else holds the ticket."""
    args = ["work", "claim", key, "--holder", env("LORE_HOLDER"), "--json"]
    for flag, value in fields.items():
        if value:
            args += [f"--{flag}", value]
    code, _ = lore(*args, ok=(0, HELD))
    return code == 0


def release(key: str, reason: str, ref: str | None = None, status: str | None = None) -> None:
    args = ["work", "release", key, "--holder", env("LORE_HOLDER"), "--reason", reason, "--json"]
    if ref:
        args += ["--ref", ref]
    if status:
        args += ["--status", status]
    lore(*args, ok=(0, HELD))


def start(ticket: dict) -> str:
    """Claim the ticket, then create its enso task. Returns a line for the log."""
    key = ticket["key"].upper()
    if not claim(key, stage="queued"):
        return f"{key}: held by someone else, skipped"
    body = "\n\n".join(filter(None, [
        (ticket.get("description") or "").strip(),
        f"Lore ticket: {key}" + (f" (priority {ticket['priority']})" if ticket.get("priority") else ""),
        "Sources:\n" + "\n".join(f"- {s}" for s in ticket["sources"]) if ticket.get("sources") else "",
    ]))
    code, out, err = enso("task", "add", f"{key}: {ticket['title']}", "--project", env("ENSO_PROJECT"), "--body-file", "-", "--unique-ref", f"lore:{key}", stdin=body)
    task = out if code == 0 else (out or {}).get("existing") if isinstance(out, dict) else None
    if not isinstance(task, dict) or not task.get("ref"):
        release(key, f"could not create the enso task: {err[:300]}")
        return f"{key}: enso refused the task ({err[:120]}); claim released"
    stage = str(task.get("stage") or "")
    claim(key, ref=task["ref"], stage=stage, status=status_for(stage))
    return f"{key}: {'started as' if code == 0 else 'already running as'} {task['ref']} ({stage})"


def reconcile(ticket: dict) -> str | None:
    """Bring one of our claims back in line with its enso task, in case a hook was missed."""
    key, held = ticket["key"].upper(), ticket["claim"]
    ref = held.get("ref")
    if not ref:
        return start(ticket)  # a run that died between the claim and the task
    code, task, err = enso("task", "show", ref)
    if code != 0 or not isinstance(task, dict):
        return f"{key}: cannot read enso task {ref} ({err[:120]}); claim left as is"
    stage = str(task.get("stage") or "")
    if stage == "done":
        release(key, f"{ref} finished", ref=ref, status="done")
        return f"{key}: {ref} done; released"
    if stage == "cancelled":
        release(key, f"{ref} was cancelled", ref=ref)
        return f"{key}: {ref} cancelled; released"
    if ticket.get("state") == "closed":
        # A person closed the ticket while it was running: stop the work, then let go.
        message = f"{key} was closed in lore"
        enso("task", "stop", ref, "--message", message)
        code, _, err = enso("task", "drop", ref, "--message", message)
        if code != 0:
            return f"{key}: closed in lore but {ref} is still running ({err[:120]}); will retry"
        release(key, f"{ref} dropped: the ticket was closed", ref=ref)
        return f"{key}: closed in lore; {ref} dropped and released"
    if stage != held.get("stage"):
        claim(key, ref=ref, stage=stage, status=status_for(stage))
        return f"{key}: caught up to {ref} ({stage})"
    return None


def dispatch() -> None:
    holder, assignee = env("LORE_HOLDER"), env("LORE_ASSIGNEE").lower()
    lore("work", "renew", "--holder", holder, "--json")
    _, tickets = lore("work", "list", "--all", "--json")
    lines: list[str] = []
    for t in tickets or []:
        if (t.get("claim") or {}).get("holder") == holder:
            line = reconcile(t)
            if line:
                lines.append(line)
    fresh = [t for t in tickets or [] if not t.get("claim") and t.get("status") == "todo" and str(t.get("assignee") or "").lower() == assignee]
    for t in fresh[: int(os.environ.get("LORE_MAX_NEW", "3"))]:
        lines.append(start(t))
    print("\n".join(lines) if lines else "nothing to do")


def transition() -> None:
    ref, stage = env("ENSO_TASK"), env("ENSO_TO_STAGE")
    code, task, err = enso("task", "show", ref)
    if code != 0 or not isinstance(task, dict):
        sys.exit(f"lore_bridge: cannot read {ref}: {err}")
    key = lore_key(task)
    if not key:
        return  # not a lore ticket
    message = os.environ.get("ENSO_MESSAGE", "").strip()
    if stage == "done":
        release(key, message[:500] or f"{ref} finished", ref=ref, status="done")
    elif stage == "cancelled":
        release(key, message[:500] or f"{ref} was cancelled", ref=ref)
    else:
        if not claim(key, ref=ref, stage=stage, status=status_for(stage), reason=message[:500] or None):
            sys.exit(f"lore_bridge: {key} is held by someone else; {ref} should not be running")
        if stage == "blocked" and message:
            lore("work", "comment", key, f"Blocked at {os.environ.get('ENSO_FROM_STAGE', '?')} ({ref}): {message}", "--by", env("LORE_HOLDER"))
    print(f"{key}: {ref} → {stage}")


if __name__ == "__main__":
    commands = {"dispatch": dispatch, "transition": transition}
    if len(sys.argv) != 2 or sys.argv[1] not in commands:
        sys.exit("usage: lore_bridge.py dispatch | transition")
    commands[sys.argv[1]]()
