# SYNTHETIC FIXTURE — NOT A REAL INCIDENT

> This document is fabricated test material for the Sentinel D2 mission. It exists so the
> agents have real text to read instead of pretending to fetch pages they have no tool for.
> Nothing in it describes a real company, product, outage, or person. Do not cite it as fact.

## Postmortem: unbounded spend on the metered inference gateway

**Incident window:** 2026-04-11 02:14 UTC to 2026-04-11 06:48 UTC (4h 34m)
**Total unrecovered spend:** $18,400
**Detection latency:** 4h 12m
**Author:** Platform Reliability (synthetic)

### Summary

A scheduled batch job that enriches support tickets with model-generated summaries entered a
retry loop against the metered inference gateway. The job held a single gateway credential with
no per-job ceiling. Over four and a half hours it issued approximately 121,000 completion
requests, of which roughly 94,000 were duplicates of eleven distinct prompts. Spend was halted
manually by an on-call engineer who noticed the billing dashboard, not by any automated control.

### Timeline

- **02:14** — Batch job `ticket-enrich` starts its nightly run against a queue of 3,100 tickets.
- **02:19** — The upstream ticket store begins returning HTTP 503 for roughly one request in
  six. The enrichment job treats any non-200 from the ticket store as a transient fault and
  retries the *entire* enrichment unit, including the already-completed model call.
- **02:31** — Retry volume exceeds the original queue depth. The job is now spending more on
  re-summarising tickets it has already summarised than on new work.
- **03:00** — Hourly spend crosses $3,900. No alert fires; the billing alert is configured on a
  daily aggregate with a 24-hour evaluation window.
- **04:40** — The ticket store recovers fully. The enrichment job does not drain its retry
  backlog, because each retry re-enqueues on failure and the backlog has grown faster than it
  drains.
- **06:26** — An on-call engineer investigating an unrelated latency page notices the gateway
  spend graph.
- **06:48** — The gateway credential is revoked manually. Spend stops.

### Contributing factors

1. **No per-job spend ceiling.** The gateway credential was account-scoped. Any job holding it
   could spend the full account balance. Credential scope and spend authority were the same
   thing, which meant the only available containment action was revocation — and revocation
   affected every other job sharing the credential.

2. **Retry granularity was wrong.** The enrichment unit wrapped a ticket-store read and a model
   call in a single retry boundary. A failure in the cheap operation forced repetition of the
   expensive one. Roughly 78% of total spend was re-computation of work that had already
   succeeded.

3. **Detection depended on human attention to a dashboard.** The only spend signal with
   sub-hour resolution was a graph nobody was watching at 03:00. The configured alert evaluated
   a daily aggregate, so it could not have fired before roughly 14 hours into the incident.

4. **Telemetry lagged the spend it described.** The gateway's usage endpoint reported figures
   that trailed actual billing by a median of 90 seconds under normal load, and by more than
   eleven minutes during the incident's peak request volume. An automated control polling that
   endpoint would have been acting on stale numbers precisely when accuracy mattered most.

### What did not work

- **Rate limiting.** The gateway enforced a requests-per-minute ceiling, and the job stayed
  under it for the entire incident. Rate limits bound request volume, not cost. Eleven thousand
  cheap requests and eleven thousand expensive requests are identical to a rate limiter and
  differ by two orders of magnitude on the invoice.

- **The daily budget alert.** Correctly configured, correctly wired, and useless at this
  timescale. It would have fired the following afternoon.

- **Revocation as a containment primitive.** Revocation did stop the bleeding, but it was
  indiscriminate: it also halted four unrelated production jobs, one of which was a
  customer-facing feature. The engineer delayed pulling the credential by roughly nine minutes
  while confirming what else would break.

### Recommendations

1. Enforce a spend ceiling **in the caller**, before the request is dispatched, rather than
   inferring overspend afterward from usage telemetry. A control that reacts to reported spend
   is always at least one round trip and one telemetry-lag interval behind the spend it is
   trying to prevent.

2. Separate retry boundaries so that a failure in a cheap dependency cannot force repetition of
   an expensive model call. Cache the completed model output keyed by input hash for the
   lifetime of the job.

3. Introduce per-job credentials with independent ceilings, so containment does not require
   revoking a credential shared by unrelated workloads.

4. Treat any spend-control mechanism that depends on polling a lagging endpoint as advisory
   only. It may be used for reporting. It must not be the only thing standing between a runaway
   job and the account balance.

### Estimated impact of recommendation 1 alone

Modelling the incident against a hypothetical pre-dispatch ceiling of $250 per job run: the job
would have been refused its 1,412th request at approximately 02:47, thirty-three minutes into
the incident, with total spend of $249.60 against the $18,400 actually incurred. The refusal
would have been recorded as a job failure requiring human attention, which is the correct
outcome — the job was in fact failing, and had been since 02:19.
