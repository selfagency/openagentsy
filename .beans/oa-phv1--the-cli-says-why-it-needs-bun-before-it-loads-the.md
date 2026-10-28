---
# oa-phv1
title: The CLI says why it needs Bun before it loads the module that needs Bun
status: todo
type: task
priority: normal
created_at: 2026-10-28T15:45:52Z
updated_at: 2026-10-28T15:45:52Z
---

The CLI's bin is dist/index.js, and index.ts imports @openagentsy/core, which imports the board, which imports bun:sqlite. Under Node the module loader throws ERR_UNSUPPORTED_ESM_URL_SCHEME (protocol bun:) before the version check runs, so the message that says the tool needs Bun is unreachable and a Node user sees a loader error instead. The fix is a small bin shim that checks process.versions.bun and then dynamically imports the rest. The engines field also lies: it says node >= 22.5.0 for a tool that cannot run on Node at all.
