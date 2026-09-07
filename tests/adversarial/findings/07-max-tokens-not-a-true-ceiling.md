# Design finding: the worst-case formula assumes `max_tokens` is a hard provider-side ceiling, which is not guaranteed

**Target:** `SENTINEL_D2_RUNNER.md` §2, step 1 ("`max_tokens` is set by us on every request, so the ceiling is knowable.")
**Status:** design review — no `src/governor/` code exists yet.
**Severity:** High. Combined with [finding 06](06-price-table-wrong-or-missing-model.md), this is the second load-bearing assumption behind "the ceiling is knowable," and it's just as unverified against the live gateway.

## The gap

The worst-case formula is `prompt_tokens_estimate × input_price + max_tokens × output_price`. The multiplication only bounds real cost if `max_tokens` genuinely bounds real output tokens billed. Three concrete ways that can fail, none addressed by the spec:

1. **Reasoning/thinking tokens billed separately.** Several current model families bill internal reasoning tokens distinctly from the visible completion, and depending on the provider and API shape, a `max_tokens`-style parameter caps only the *visible* completion, not the reasoning budget. If the gateway or the specific routed model does this, real output-side billing can exceed `max_tokens × output_price` while the client-visible completion looks perfectly bounded. Nothing in `docs/MCP_SURFACE.md` documents which models/pricing shapes the gateway actually exposes, so this isn't a settled non-issue — it's unverified.
2. **Provider/gateway bugs or version drift.** A parameter silently not being honored (wrong field name accepted without error, a gateway proxy layer dropping it, a model that only respects it "approximately") is a mundane, well-precedented failure class for any wrapped third-party API, not a hypothetical.
3. **Multi-turn tool-use accounting.** §3's mission requires multi-step tool use (search, fetch, synthesize). If `max_tokens` is set per-request but the worst-case estimate in step 1 is computed once per logical "call" rather than per actual request the provider sees (e.g., a tool-calling turn that internally involves more than one model round trip before the tool-call message is returned), the estimate can undercount how many times `max_tokens × output_price` is actually paid for what the governor books as one reservation.

## Why this defeats the scheme in the same direction as findings 04-06

All of these produce the same shape of failure: an admission check that looks correct (worst-case ≤ remaining budget, call admitted) followed by a reconciled real cost that exceeds what was reserved. The spec never says what happens when `usage.cost` at reconciliation (step 4) is *larger* than the reservation that was made for it in step 1. Read literally, step 4 just "commits the real cost" — implying `committed_total` absorbs the overage without complaint, meaning a single call can push cumulative committed spend past what every prior admission check believed was the ceiling. If that overage is what tips a mission over its $1.00 budget, the breach is discovered after the money is spent, exactly the failure category Day 1's adversarial review already flagged as fatal for a post-hoc-only design (see [finding 02](02-balance-drain-path-and-breaker-placement.md)) — except here it's not a concurrency race, it's a single serial call whose real cost was mis-modeled from the start.

## Concrete scenario

1. Escalated model (per §4's `MODEL_ESCALATED` rule) is a reasoning model. `max_tokens = 2000` is set on the request, priced at the table's visible-output rate.
2. The model internally spends 6,000 reasoning tokens (billed) to produce a 2,000-token visible completion. The gateway's `usage.cost` reflects the true 8,000-token-equivalent charge.
3. Worst-case reservation, computed from `max_tokens = 2000` only, admitted the call as costing at most (say) $0.10. Real reconciled cost is $0.35.
4. `committed_total` jumps by more than any single admission check ever approved. If this is the mission's last planned call, the mission believes it finished within budget right up until this reconciliation, and the $0.25 gap was never visible to any refusal logic that could have prevented it.

## Question the design needs to answer before implementation

- Has the actual per-model billing shape been verified against live `usage` objects from this gateway (the way Day 1 verified `orbio_get_balance`'s shape), specifically checking whether every billed token category is bounded by the request's `max_tokens`-equivalent parameter? This is a gateway/model-specific fact, not something safe to assume from the parameter's name.
- Does the governor treat "reconciled cost exceeded its own reservation" as a distinguishable alarm condition (it should never happen if the ceiling assumption holds, so its occurrence is itself diagnostic), or does it disappear into `committed_total` as an ordinary commit?

## Suggested direction (not implementation)

Verify the ceiling assumption empirically per model before trusting it (a handful of real calls with generous `max_tokens` margins, comparing predicted vs. `usage.cost`), and instrument the governor to flag — not just silently absorb — any reconciliation where real cost exceeds the reservation that admitted it. A worst-case bound that can be silently wrong is not a worst-case bound.
