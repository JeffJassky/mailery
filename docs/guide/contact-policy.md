# Contact policy

Flows, broadcasts, one-off sends and Programs each decide on their own to send. Nothing in them stops three marketing emails reaching one person before lunch. The contact policy is one stage in dispatch that looks at what an address has already been sent and decides, per send: **send now**, **defer**, or **drop**.

It is off by default. With no `contactPolicy` in your config, dispatch behaves exactly as it did before 0.21.

## Configuration

```ts
Mailer.init({
  // ...
  contactPolicy: {
    marketing: {
      minGapHours: 20,                                  // between any two marketing sends to one address
      maxPerRollingDays: { days: 7, count: 3 },         // at most 3 in any rolling 7 days
      quietHours: { start: '21:00', end: '08:00' },     // recipient-local; start > end spans midnight
      defaultTimezone: 'America/New_York',              // used when nothing better is known
      deferral: { maxHours: 72 },                       // default 72
    },
    sourcePriority: ['transactional', 'flow', 'oneoff', 'broadcast', 'program'], // this is the default
  },
})
```

Every key is optional; omit a rule to switch it off. Invalid values throw at init.

## What counts

- **Only marketing.** Transactional templates bypass every rule and are never counted. They are still written to `mailer_sends` like any other send.
- **History** is marketing sends to the same address (compared lower-cased) that actually went out: `sentAt` is set. Failed, cancelled, suppressed, deferred and holdout rows never open a gap.
- Windows are **rolling**, not calendar days. With `{ days: 1, count: 1 }` a send at 23:00 blocks one at 01:00 the next morning.

## The rules

For one send, `now` is dispatch time:

| Rule | Earliest allowed time |
| --- | --- |
| Gap | last marketing `sentAt` + `minGapHours` |
| Cap | if `count` or more sends fall in `(now − days, now]`: the `count`-th most recent `sentAt` + `days` |
| Priority | if a *strictly higher-priority* origin has a pending send to the same address that is due now: `now + minGapHours` (one hour when `minGapHours` is unset) |
| Quiet hours | applied last: if that time falls inside quiet hours, the moment the quiet period ends |

The send is allowed at the latest of those. If that is `now`, it goes. Otherwise it is **deferred** to that time, and the reason recorded is the rule that produced it (`min_gap`, `rolling_cap`, `priority`, `quiet_hours`; quiet hours win a tie because they are applied last).

Quiet hours are computed in the recipient's local time and are DST-correct: a quiet period that spans a clock change still ends at the right local wall-clock time.

## Which timezone

`contact.timezone` → the send's `timezoneHint` (Programs set it from the `timezone` fact) → `marketing.defaultTimezone` → `UTC`. A value that is not an IANA zone is skipped, not an error.

## Defer, then drop

A deferred send is written as `status: 'deferred'` with `notBefore` and `policyDeferral { reason, firstDeferredAt, count }`, and a delayed job is queued for `notBefore`. The mailer tick also releases any deferred send whose time has passed, so a lost job never strands one.

On re-dispatch everything runs again: suppression, the circuit breaker, the originating system's guard (a flow's abort check, a Program's re-verify), then the policy. The send can be deferred again; `firstDeferredAt` keeps its first value and `count` rises.

Expiry is measured from when the send was **queued**, and judged on the final time, after quiet hours. If the earliest allowed time is later than `queuedAt + deferral.maxHours`, the send is not deferred but **dropped**: `status: 'cancelled'`, `exitReason: 'policy_expired'`, no provider call. Sending a two-day-old "your trial ends tomorrow" would be worse than not sending it.

A deferred send is not history, so it does not push other sends back; only what was actually sent does.

## Priority

When a send meets a *pending* send to the same address from a strictly higher-priority origin that is due now, the lower one waits. Origins are `flow`, `oneoff`, `broadcast`, `program` (listed in `sourcePriority`, highest first; an origin not listed ranks below all listed ones). Equal priority is first come, first served. A higher-priority send that is itself deferred to later is not contention.

## Concurrent sends

Two marketing sends to one address dispatched at the same moment would both see an empty history. Dispatch therefore takes a short per-recipient lock (collection `mailer_contact_locks`, one row per address) from the decision until the send is final, including render and the provider call.

- The lock expires after **60 seconds**, and the holder renews it every **15 seconds** while it works, so a slow provider call never lets a second dispatch in.
- A crashed worker stops renewing, so its lock frees the address within 60 seconds. A TTL index also removes abandoned rows.
- Only the owner can release or renew a lock.
- A waiting dispatch polls for up to **45 seconds**, then hands the send back to the queue (retry in 5 seconds). If taking the lock errors, the send is marked `failed` so the queue's retry re-claims it.

## Watching it

- Admin UI: deferred sends show an amber **Deferred** status with the reason and release time on the Sends list, the send detail page and the contact page. Dropped sends show **Cancelled** with `policy expired`.
- API: `GET /sends?status=deferred` lists them; each row carries `notBefore`, `policyDeferral` and `exitReason`.
- Counts: `db.mailer_sends.aggregate([{ $match: { status: 'deferred' } }, { $group: { _id: '$policyDeferral.reason', n: { $sum: 1 } } }])`. A growing `quiet_hours` or `rolling_cap` count is the policy working; a growing count of `cancelled` with `exitReason: 'policy_expired'` means the rules are tighter than `deferral.maxHours` allows.
- Aborting a flow (`abortFlow`, `abortAllFlows`) cancels its deferred sends too, even when the run has already completed, and reports each to the flow's `onOutcome` as `cancelled`.
- Cancelling a broadcast cancels its deferred sends; a broadcast's stop rules treat deferred sends as still pending.

## Limits

No per-category caps and no digests or batching. Transactional mail is never delayed.
