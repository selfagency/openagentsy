---
# oa-jllw
title: The credential broker and the keyring
status: todo
type: task
priority: normal
created_at: 2026-10-28T15:25:06Z
updated_at: 2026-10-28T15:25:06Z
---

Plan section 23. oa_credential_request is human-only; a request surfaces a prompt, an allow issues a short-lived encrypted credential, the agent never sees the raw secret, broker.use injects it into the tool's execution context, and credential_audit records every action.
