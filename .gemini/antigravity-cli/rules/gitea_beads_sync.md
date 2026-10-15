---
description: "Rules for tracking and synchronizing bugs and features across Beads and Gitea."
---

# Issue Tracking & Synchronization Rule: Beads & Gitea

1. **Dual Publishing**:
   Whenever a new bug, defect, feature request, or enhancement is identified or required in any project:
   - Record it locally in Beads:
     ```bash
     bd create "<Title>" -t bug|feature
     ```
   - If the project repository has a Gitea remote (e.g. `http://192.168.8.177:3000/...`), ALSO publish it to Gitea as an issue with the matching type (`bug` or `feature`):
     ```bash
     gitea-issue create --type bug|feature --title "<Title>" --body "<Details>" --beads-id "<beads-id>"
     ```

2. **Verification Before Closing**:
   - DO NOT close issues automatically (`bd close` or `gitea-issue close`) when code changes are complete.
   - Leave both Beads and Gitea issues open until the user has tested and verified the solution in their environment.

3. **Closing Verified Issues**:
   - When the user verifies the fix or feature (or explicitly requests closing the issue):
     ```bash
     bd close <beads-id>
     gitea-issue close <gitea-issue-number>
     ```
