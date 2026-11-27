# Phase 3.6.2 — prospective checkpoint prices

The running application is `original-node-app` (Render root directory); the
repository-root and `kalshibot-node-main` copies are older upload remnants.
The deployed checkpoint recorder omitted `quote` even though the shadow report
already read it. The fix saves the same market bid/ask snapshot and fetch time
alongside each new checkpoint, validates all four prices and a maximum 30-second
local fetch age, and copies the quote so later refreshes cannot mutate it.
The timestamp describes local market retrieval, not exchange-event freshness.

Existing checkpoint payload JSON supports the new fields: no SQL, environment
or research-start-date changes. Legacy rows remain unpriced. Restarting, later
spot evaluation and a new market snapshot never backfill a missing quote.

`/api/health` reports researchPhase 3.6.2. `/api/checkpoints` exposes
quoteCaptureVersion, quoteCoverage and new journal quote/quoteStatus fields.
`/api/checkpoint-shadow` exposes quoteCaptureVersion, checkpoint pricing coverage,
firstQuoteAt, and each strategy's unpricedGraded count. Current open checkpoints
appear immediately in `/api/checkpoints`; shadow pricing counts appear after close
and official grading, with the existing five-minute report cache. An abstention
can have a valid quote without producing a priced hypothetical strategy signal.

Historical null P/L and Brier values remain null. New priced comparisons use the
observed checkpoint ask plus the existing illustrative fee. No fills are assumed.
Directional rules, cohort boundaries, persistence, demo and production disablement
are unchanged. `npm test` in original-node-app includes recorder/persistence,
stale quotes, restart/no-backfill and shadow-pricing regression checks.
