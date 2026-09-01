# Taobao Transient Result Snapshot Retry Design

## Context

The native search submission path now activates Taobao Desktop, replaces the
exact profiled search field, verifies the fresh field value, and submits with
Return. A live command trace proved that all of those commands succeed.

Immediately after Return, Taobao rebuilds its web accessibility tree. The first
result snapshot can therefore fail with helper code `NODE_NOT_FOUND` even
though the query was submitted successfully. Treating that one transition
state as permanent aborts a valid search.

## Decision

`waitForStableSearch` will treat only
`AxHelperResponseError("NODE_NOT_FOUND")` from a result snapshot as a
transient observation failure.

The retry remains inside the existing result-stability loop:

- the existing 15-second deadline is unchanged;
- the existing requirement for three consecutive stable observations is
  unchanged;
- a transient failure clears the current consecutive-observation state;
- the initial post-submit transition may be latched exactly as it already is
  for a temporarily unrecognized result tree;
- polling resumes after the existing interval.

No mutation is retried. In particular, the driver does not reactivate the app,
replace the query again, or send another Return key event.

## Error Boundaries

Only the exact helper response code `NODE_NOT_FOUND` is recoverable in
`waitForStableSearch`. Other helper failures continue to propagate
immediately. Persistent transient failures exhaust the same 15-second deadline
and return the existing search-stability timeout.

The change does not alter initial field discovery, exact path and fingerprint
validation, post-write value verification, pagination, API integration,
persistence, scheduling, Enterprise WeChat, notifications, or repricing.

## Tests

Focused driver tests will prove:

1. A single post-Return `NODE_NOT_FOUND` snapshot is followed by normal stable
   observations, returns one result, and sends exactly one `replaceText` and
   one Return event.
2. Repeated `NODE_NOT_FOUND` snapshots stop at the existing deadline without
   resubmitting the query.
3. A different helper response error still propagates without retry.

After focused tests pass, the full collector suite, TypeScript typecheck, Swift
production helper build, three diagnoses, and the two sanitized live probes
will be rerun.
