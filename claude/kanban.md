---
description: Work the next kanban task for this project (or a given task id) and report back to the board
argument-hint: [task-id]
---

You are connected to the company kanban board through the `kanban` MCP server.

1. Call `list_projects` and pick the project whose `local_path` matches the current working directory
   (fall back to asking me if none matches).
2. If I gave you a task id ($ARGUMENTS), call `get_task` with it. Otherwise call `get_claude_queue` for
   that project and take the first task. If the queue is empty, say so and stop.
3. Call `claim_task` with a one-line plan. Then do the work in this repository:
   - create a branch named after the task (e.g. `kanban-<id>-<short-slug>`) unless I say otherwise,
   - make the change, run the project's tests/linters,
   - commit, push, and open a pull request. Do NOT merge it.
4. While working, use `add_worklog` for decisions or findings worth keeping.
5. When done, call `complete_task` with: a summary of what changed and how it was verified, anything left open,
   the branch name and the PR URL. Leave the lane at `review` so I can review and merge.
   If you are blocked, call `complete_task` with `lane: "todo"` and explain what you need.
