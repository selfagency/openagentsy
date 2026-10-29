---
# oa-dxjb
title: The workspace rule does not see a shell write either
status: todo
type: bug
priority: high
created_at: 2026-10-29T14:56:17Z
updated_at: 2026-10-29T14:56:17Z
---

Found while fixing the same hole in the protect policy (oa-scyy): the shell branch of the workspace-writes-only rule has the same shape - it reads call.files, which the file tool fills and a shell command does not. A shell command that writes outside the workspace and outside the worktrees (cp to /tmp, or a redirect into /etc) is not caught by the workspace rule, only by the destructive-needs-approval gate when the command happens to look destructive. The helper that the protect-policy fix introduces should be reusable here; this task is to adopt it and to measure whether the fail-closed stance (an unknown command name is a writer) produces false positives that would block legitimate work.
