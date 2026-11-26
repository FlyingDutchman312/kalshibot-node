# Kalshibot Phase 3.1 — deployment

Upload only the changed `server.js`, `public/index.html`, and `public/paper.js` to the corresponding paths inside `original-node-app` of your GitHub repository. `public/app.js` is included unchanged for reference. Keep `npm start`, root directory `original-node-app` on Render.

## Persistence setup

Run `PHASE31_SUPABASE.sql` in a Supabase project SQL editor. In Render > Kalshibot service > Environment, add `KALSHIBOT_SUPABASE_URL` (HTTPS project URL) and `KALSHIBOT_SUPABASE_SERVICE_KEY` (the service-role/server-only key). Never include these keys in GitHub or browser JavaScript. Service-role keys bypass RLS, so isolate this app where possible.

After redeployment, visit `/api/paper-journal` and check `storage` and `persistence.state`. `storage: supabase` means the table was contacted; `degraded` means storage failed, and in-memory data is not durable. Without environment variables, storage is `volatile`. Historical observations already lost from Render memory cannot be restored.

`/api/paper-signal` now includes `reasonCode` explaining `NONE`: WARMUP, STALE_BTC_PRICE, WEAK_MOMENTUM, MOMENTUM_CONFLICT. EXPERIMENTAL_MOMENTUM marks an UP/DOWN signal. These are experimental public spot indicators, not calibrated AI probabilities, actual trades, official Kalshi settlements, or ROI.

Live trading remains disabled: the server never loads a trading agent, and write HTTP methods return 403. Do not configure Kalshi production API keys.
