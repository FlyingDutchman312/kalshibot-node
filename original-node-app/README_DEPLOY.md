# Kalshibot Mission Control — Phase 2, read-only and paper signals

## Replace exactly three files in GitHub
- `original-node-app/server.js`
- `original-node-app/public/app.js`
- `original-node-app/public/index.html`

Keep Render **Root Directory** as `original-node-app`, Build `npm install`, Start `npm start`.

## Private Kalshi account view (optional)
In Render > Environment, add these secrets (not to GitHub):
- `KALSHI_API_KEY_ID`: Kalshi API Key ID
- `KALSHI_PRIVATE_KEY_PEM`: the full RSA private key PEM (use multiline value or literal `\n` for newlines)
- `ACCOUNT_VIEW_PASSWORD`: long, unique password solely for accessing the private account view. Do not use your Kalshi login password.

Use a Kalshi key with read-only permissions **if supported for your key/account**, and always verify its privileges. The app only implements GET requests for balance and positions, and never imports/starts the original trading engine.

Click **View my Kalshi account** in the dashboard, enter the separate viewer password. The dashboard never stores the password in localStorage. The API response is private to that request, not broadcast over Socket.IO. Do not share screenshots of portfolio balances or network responses.

**Security note:** The original web server still publicly serves dashboard status/market data. If account privacy matters, restrict access to the overall app via a platform access control or VPN, not only this endpoint. Browser prompts and a single password are basic protection; they are not a full multiuser authentication system. HTTPS is required.

## Paper signal
BTC spot observations every ~15 seconds. With at least eight observations, the app displays a simple momentum direction or NONE. This is NOT a trained model, and probability and market edge intentionally remain blank. Do not interpret paper signals as predictions or investment recommendations. All trading endpoints are blocked (non-GET returns HTTP 403). Paper signal history is not persisted and can reset on Render cold starts.

## Verify
- `/api/health` shows `botRunning:false`
- `/api/paper-signal` shows experimental status and signal fields
- `/api/market-data` shows public feeds
- `/api/account` without credentials returns 401 when configured or 503 when not configured
- `POST /api/bot/start` must return 403.

Never put your Kalshi credentials, private key, or viewer password in chat or GitHub.
