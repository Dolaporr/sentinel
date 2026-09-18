# SYNTHETIC FIXTURE — NOT REAL MEASUREMENTS

> This document is fabricated test material for the Sentinel D2 mission. It exists so the
> agents have real text to read instead of pretending to fetch pages they have no tool for.
> The figures below are invented for illustration. Nothing here describes a real system,
> benchmark, or vendor. Do not cite it as fact.

## Measurement note: how far worst-case cost estimates sit from billed cost

**Status:** synthetic / illustrative
**Method (nominal):** 4,000 completion requests across three model tiers, comparing the
caller's pre-dispatch upper-bound estimate against the provider's reported billed cost.

### Why this was measured

A pre-dispatch spend control is only as good as its cost bound. Teams adopting one tend to
assume the bound is roughly right and discover much later that it is off by an order of
magnitude in one direction or the other. Both directions are harmful, and they are harmful in
different ways:

- **Bound too low** — the control admits calls it cannot afford. The ceiling silently stops
  being a ceiling. Individual admission checks still pass; the breach only surfaces at
  reconciliation, after the money is spent.
- **Bound too high** — the control refuses work the budget could comfortably cover. Nothing is
  overspent, but throughput collapses and the reported budget figures stop describing reality.

### Headline findings

**Finding 1: output ceiling dominates the error.** Across the sample, the single largest source
of divergence between bound and billed cost was the gap between the requested output ceiling and
the tokens actually generated. Median utilisation of the requested ceiling was 11%. The 90th
percentile was 34%. No request in the sample exceeded 71% of its declared ceiling.

**Finding 2: utilisation is task-dependent, not model-dependent.** Grouping by model produced no
useful signal. Grouping by task shape did. Extraction and classification tasks clustered at 4–9%
utilisation regardless of tier. Long-form synthesis clustered at 28–52%. Tasks whose prompts were
ambiguous or under-specified clustered lowest of all — around 2% — because the model responded
with a short clarifying question rather than attempting the work. Roughly one in nine requests in
the sample fell into this category, and those requests produced no usable output while still
being billed.

**Finding 3: declared input size is a common and under-examined error.** In 3 of the 11
implementations surveyed, the input token figure used for the bound was a constant baked into a
task definition rather than a measurement of the prompt actually being sent. In the worst case
observed, the declared figure exceeded the real prompt by a factor of 60. Because the resulting
error inflates the bound rather than deflating it, it does not cause overspend and is therefore
rarely noticed — it presents as an inexplicably conservative control that refuses affordable
work.

**Finding 4: setting the ceiling near observed maximum output recovers most of the accuracy.**
Re-running the sample with output ceilings set to 1.5× the observed 99th-percentile completion
length for each task shape reduced the median bound-to-billed ratio from 14.2× to 1.9×, with no
observed instance of a completion exceeding its ceiling.

**Finding 5: the residual ratio is irreducible and should be preserved.** Even at well-calibrated
ceilings, the bound exceeded billed cost in every single request in the sample. This is expected:
the bound prices the ceiling, and completions stop when the task is done. Attempts to close the
remaining gap by applying a fractional "expected utilisation" discount to the bound reintroduce
exactly the failure the bound exists to prevent, because utilisation is a distribution and the
discount is a point estimate. Three of the surveyed implementations had done this. All three had
a bound that was no longer an upper bound.

### Secondary observations

- **Reasoning-token billing breaks naive bounds.** Where a model bills internal reasoning tokens
  separately from the visible completion, and the output ceiling parameter caps only the latter,
  billed cost exceeded the bound in 6% of requests to those models. A bound computed from the
  visible ceiling alone is not an upper bound for such models, and the control silently loses its
  guarantee for exactly the requests most likely to be expensive.

- **Missing cost fields are not rare.** 2.3% of responses in the sample carried no usage or cost
  information. These were disproportionately concentrated in intermediate tool-calling turns and
  in responses truncated by a transport fault. Implementations that defaulted such calls to zero
  cost under-counted total spend by a median of 3.1% and, in one case, by 22%.

- **Cut streams are the worst case for reconciliation.** A connection dropped mid-generation
  produces tokens that were generated, and therefore billed, but no terminal message reporting
  what they cost. Treating these as zero systematically under-counts. Treating them as the full
  reservation over-counts but errs in the safe direction.

### Practical guidance

1. Derive the input figure from the prompt you are actually sending, at the moment you send it.
   A constant in a task definition will drift from reality and will not announce that it has.
2. Set output ceilings from measured completion lengths for that task shape, with headroom —
   not from a round number chosen for comfort.
3. Expect a residual bound-to-billed ratio somewhere near 2×. Treat a ratio above roughly 5× as
   a calibration defect worth investigating, and a ratio below 1× as an emergency.
4. Never apply an expected-utilisation discount to an upper bound. If the bound is too loose,
   fix its inputs.
