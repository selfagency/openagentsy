# The tells, and the preserve list

The lint reads a comment and asks two questions: does it carry a tell,
and does it carry meaning. The preserve list is asked first, so a
comment that explains something is never a finding.

## The six tells

### Decorative marker

A marker with no content: a box of dashes, a row of stars, an arrow
pointing at nothing, a `// ---` that separates nothing.

```ts
// *******
// *******
```

Delete it. The structure it marks is in the code.

### Banner separator

A banner, or a section label in capitals.

```ts
// ============ HANDLER ============
```

Delete the banner, or write the label in sentence case and let the
function name carry the section. A comment that says "handler" above a
function called `handleRequest` says nothing twice.

### Step narration

The code written out in words.

```ts
// Step 1: increment the counter
counter += 1;
```

Delete it. The code says it, and a step that can be narrated can be
read.

### Empty label

A label with no content. "Main logic", "Helper function", "Process
the data", "Update state".

```ts
// Main logic
```

Say what the code does, instead of the label. If the code is obvious
enough that the label adds nothing, the label goes.

### Empty TODO

A TODO that names no task.

```ts
// TODO: fix this
```

Name the task, or delete the TODO. A TODO with no task is a wish, and
a wish in the source is a thing the next reader has to resolve.

### Redundant JSDoc

A JSDoc that repeats the signature and says nothing more.

```ts
/**
 * Returns the total.
 * @param values - The values.
 * @returns The total.
 */
function total(values: number[]): number {
```

Say what the function does, or delete the JSDoc. A JSDoc that only
restates the types is noise in a file where the types are already
written.

## The preserve list

A comment that explains any of these is never a finding, whatever
shape it is in. The list is data: one entry per kind of comment that
carries meaning, and every rule asks the same list before it says
anything.

| Kind | What it covers |
| --- | --- |
| licence | copyright, SPDX, an author, an attribution, a derived-from note |
| security | a boundary, a threat, a trust decision, a sanitised input, a redacted value |
| performance | a hot path, a cost, a measurement, a cache, a constant-time claim |
| concurrency | a lock, an ordering, a race that is closed, a happens-before edge |
| API contract | a spec, a wire format, a status code, a header, a schema, a version |
| business logic | the rule the code implements, the policy, the price, the limit |
| workaround | the edge case, the quirk, the reason it is like this until the fix lands |

The order the list is asked in does not matter: a comment that explains
anything is kept.

## The shapes that pass

```ts
// The lease check is the only thing standing between a write and a file
// nobody owns, so it fails closed: no leases means no writes at all.
```

```ts
/**
 * Decides a write against the leases.
 *
 * The decision is made on the absolute path, because a lease is
 * written as an absolute glob and a relative one would match the wrong
 * file.
 */
```

```ts
// The board refuses a fourth writer, so two builders on disjoint files
// are fine and three on the same file are not.
```

Each one says why, or what breaks if it changes, and none of them says
what the next line does.
