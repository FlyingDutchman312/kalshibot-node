# Phase 3.6.3 — research-health overview

The original Mission Control dashboard now shows a compact health table for its
local BTC collector, the separate seven-market research app and Precision Scalper.
`GET /api/research-health` serves the same sanitized report. Remote public GETs
are cached for 60 seconds and coalesced; local freshness is recalculated on each
read. There are no new credentials, database writes, recovery triggers, model
changes or trading actions. The browser skips refreshes while hidden.

The original bot reports recent missed checkpoints, quote repair records, pending
checkpoint writes and its discovered settlement backlog. These are bounded
windows, not lifetime inventory. The other apps expose different counters, so
unavailable checkpoint/backlog counts show **Unknown**. Precision's recovered
historical 429 count does not label a healthy feed down; an active cooldown shows
**BACKOFF**. Poll ages and persistence errors stay visible separately.

This is research operations monitoring, not a trading-readiness gate. No missing
forecast is recreated and no pending official result is assumed. Private account
and API-key fields from source payloads are never forwarded in the report.

The new backend lives in `original-node-app/research-health.js`; its UI lives in
`original-node-app/public/research-health.js`. Keep the existing Render root.
No SQL or environment change is required. `npm test` includes stale feed,
malformed source, coalescing/cache, disablement and safe error-output tests.
