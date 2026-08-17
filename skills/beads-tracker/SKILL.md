---
name: beads-tracker
description: >-
  Use this skill whenever working in any project to manage task tracking. You must ensure new projects are initialized with `beads` (the bd command), any newly discovered bugs or required tasks are created as issues, and any completed issues are resolved.
---

# Beads Project Tracker

You are required to use the `beads` (or `bd`) CLI issue tracker to manage project tasks, bugs, and features. The executable is located at `~/.local/bin/bd` or simply `bd` if it's in the PATH.

## Initialization
When working on a new project or entering a workspace for the first time, you must initialize `beads` if it hasn't been initialized already (i.e. if the `.beads` directory is missing).
Run the following command in the project root:
```bash
bd init
```
*(If prompted non-interactively, you may need to pass an empty line like `echo "" | bd init`)*

## Issue Management
Throughout your workflow, actively manage issues using the following commands:
- **List ready tasks**: `bd ready` (shows tasks with no open blockers)
- **List all tasks**: `bd list`
- **Create a new issue**: `bd create "Description of the issue or task"`
- **Claim a task to work on**: `bd update <issue-id> --claim`
- **Mark an issue as resolved**: `bd close <issue-id>`
- **Link tasks by dependency**: `bd dep add <child-id> <parent-id>`

### Rules to Follow:
1. **Creation**: When you encounter a new bug, realize a feature requirement, or determine a multi-step task is needed, immediately run `bd create "..."` to record it.
2. **Resolution**: When you finish implementing a fix or a feature, immediately run `bd close <issue-id>` to mark it as resolved.
3. **No manual edits**: Beads uses a database/files in the `.beads/` directory. You should always use the `bd` CLI to interact with it rather than modifying those files directly.
