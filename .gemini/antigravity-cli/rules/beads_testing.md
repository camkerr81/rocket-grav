---
description: "Instructions for handling Beads issues, Gitea sync, and issue closures."
---

When working on bugs, features, or any Beads (bd) issues:
1. Ensure all bugs and features are recorded in Beads (`bd create -t bug|feature`) AND published to Gitea via `gitea-issue create --type bug|feature`.
2. DO NOT use `bd close`, `bd complete`, or `gitea-issue close` to close issues automatically when you finish code changes.
3. The user prefers to thoroughly test the code in their environment first.
4. Instead of closing the issue, leave it open and explicitly tell the user that the code is ready for them to test, and that they can close the issue (or ask you to close it) once they have verified it works.
