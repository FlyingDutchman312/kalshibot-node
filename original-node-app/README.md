# Kalshibot Mission Control — safe read-only Render deployment

This package retains the original Mission Control frontend and replaces its server with a **read-only** public-data implementation. It does **not** import, initialize, or call `MasterAgent`, trading/order modules, or account APIs. All non-GET HTTP requests receive 403.

## Deployment

1. Create a **new** GitHub repo or replace the files **inside `original-node-app/`** in the repo already connected to Render. For an existing deployment with Root Directory `original-node-app`, put `server.js`, `package.json`, `public/` and other files directly inside that folder. Do **not** upload the outer `kalshibot_readonly_node` folder as an extra nested directory.
2. Render: Root Directory `original-node-app` if that's where files live; otherwise blank if package.json is in repo root. Build `npm install`, start `npm start`.
3. Do not provide Kalshi production secrets, Polymarket keys, private keys, or trading credentials.
4. Use `/api/health` and `/api/market-data` to diagnose current public feed state.

BTC: Coinbase public BTC/USD spot (Kraken fallback) every 15 seconds. Kalshi: public `KXBTC15M` series markets every 30 seconds. Quote fields can vary with API changes; errors appear in `/api/market-data` and Render Logs. No claims of executed trades or AI predictions.

Existing P&L chart remains empty unless the browser already has localStorage history from a previous deployment; this new server does not generate trades. The new BTC chart starts filling from live polls and resets after Render restarts or sleeps.

**Security note**: This replacement server cannot execute trades, but anyone who has access to the public URL can see public market data. This code is not a substitute for access control if adding account information later.
