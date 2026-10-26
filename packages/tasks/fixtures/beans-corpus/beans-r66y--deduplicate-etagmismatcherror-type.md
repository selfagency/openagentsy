---
# beans-r66y
title: Deduplicate ETagMismatchError type
status: todo
type: task
created_at: 2026-03-14T15:06:45Z
updated_at: 2026-03-14T15:06:45Z
parent: beans-5txp
---

ETagMismatchError is defined identically in both pkg/beancore/ and internal/graph/. Should exist in one canonical location (pkg/beancore/ makes sense since that's where ETag validation happens) and be imported elsewhere.

## Affected Files

- pkg/beancore/core.go
- internal/graph/schema.resolvers.go
