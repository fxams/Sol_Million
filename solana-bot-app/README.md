# solana-bot-app

MEV-protected (Jito bundle) Solana bot monorepo:

- `frontend/`: Next.js 14+ App Router dashboard with Solana wallet connect (Phantom/Solflare/Backpack), bot config UI, live logs, bundle history, and client-side signing.
- `backend/`: Node.js + Express (TypeScript) service that monitors Raydium AMM pool creation logs via Helius WebSocket, prepares **unsigned** transactions, and (when enabled) simulates + submits **Jito bundles** built from **client-signed** transactions.

> **Security model (critical):**
> - **No private keys ever touch the backend.**
> - **All transactions are signed client-side** using the connected wallet.
> - Backend only prepares **unsigned** transactions and/or bundles **already-signed** transactions for Jito.

---

## How MEV protection works (Jito bundles)

On Solana, a “normal” transaction sent through a public RPC can be observed/contended with by other parties before it lands. For sniper/volume strategies this often leads to **front-running / sandwiching**.

**Jito bundles** mitigate this by sending an ordered set of transactions directly to the Jito Block Engine (validators), bypassing the public mempool view. Validators attempt to execute the bundle **in-order**, typically as an **atomic package** (all-or-nothing depending on bundle type/validator policies).

This repo uses the pattern:

1. Backend detects an opportunity (ex: Raydium pool init logs).
2. Backend prepares **unsigned** transactions (buy + **tip tx last**).
3. Frontend wallet signs each transaction locally.
4. Frontend sends the **signed** serialized txs to backend.
5. Backend **simulates** the bundle first.
6. Backend **submits** the bundle to Jito and exposes bundle status via `/api/status`.

**Tip best-practice:** bundle’s last tx is a **SystemProgram.transfer** to a Jito tip account. This repo randomizes tip lamports with a minimum of **1000**.

> Jito limits vary by region/validator, but a common rule of thumb is **max ~5 tx per bundle**.

---

## Repo structure

```
solana-bot-app/
  frontend/    # Next.js 14 App Router UI
  backend/     # Express + TS + Helius WS + Jito JSON-RPC
  README.md
  .gitignore
```

---

## Prerequisites

- Node.js 18+ (recommended 20+)
- A Solana wallet browser extension:
  - Phantom
  - Solflare
  - Backpack
- **Helius** account (for reliable HTTPS + WebSocket RPC)
- **Jito Block Engine** endpoint (mainnet only)

---

## Setup (local dev)

### 1) Backend

```bash
cd solana-bot-app/backend
cp .env.example .env
npm install
npm run dev
```

Backend runs on `http://localhost:8787`.

#### Backend environment variables

Edit `backend/.env`:

- **`HELIUS_RPC_URL`**: mainnet HTTPS RPC (Helius recommended)
- **`HELIUS_WS_URL`**: mainnet WebSocket RPC (Helius recommended)
- **`JITO_BLOCK_ENGINE_URL`**: Jito JSON-RPC endpoint for bundles
- **`FRONTEND_ORIGIN`**: CORS allow-list origin for the frontend

**Important (Jito URL format):** some setups require the `/api/v1/bundles` path.

Examples you may need to try:

- `https://mainnet.block-engine.jito.wtf/api/v1/bundles`
- Regional:
  - `https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles`
  - `https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles`
  - `https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles`
  - `https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles`

### 2) Frontend

```bash
cd solana-bot-app/frontend
cp .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000`.

---

## Usage

1. **Connect wallet** (top-right).
2. Configure:
   - Buy amount (SOL)
   - TP/SL
   - Min liquidity filter (template placeholder unless you implement reserve parsing)
   - Auto-sell delay
   - Mode: Snipe vs Volume/Arb
   - Optional snipe list (mint addresses)
   - Toggle **MEV protection**
3. Click **Start monitoring**.
4. When a qualifying Raydium pool init is detected:
   - A **Pending action** banner appears.
   - Click **Sign & submit pending bundle**.
5. Watch:
   - Live logs (bundle simulation/submission status)
   - Bundle history with Solana Explorer tx links + Jito Explorer bundle link

---

## Devnet vs Mainnet

- **Devnet**: use it to validate your UI flows and wallet signing.
  - This template allows public test tx submission on devnet when **MEV is disabled**.
- **Mainnet**: required for **Jito bundle submission** (MEV protection).

To switch, use the cluster dropdown in the UI and ensure your backend `.env` points at the correct RPCs.

---

## Implementation notes (important)

### Raydium monitoring

Backend uses a WebSocket `logsSubscribe` for the Raydium AMM program:

- `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1dvX`

It heuristically matches pool initialization logs (e.g. `initialize2`). For a real production sniper, you typically also:

- Fetch the confirmed transaction for the signature
- Parse pool accounts and reserves
- Enforce filters (min liquidity, token allow/deny lists, mint safety checks)

### Swap building (template vs production)

This repo is intentionally **keyless** and keeps the bot safe-by-default. The backend’s “buy/sell tx builder” currently emits **placeholder memo-based transactions** that compile and demonstrate the end-to-end signing/bundling flow.

To make it a real sniper/volume bot, replace the memo instruction in:

- `backend/src/services/txBuilder.ts`

with real swap instructions, e.g.:

- Raydium SDK (pool keys + route building)
- Jupiter swap API (note: for true atomic bundles you still need deterministic tx building and careful simulation)

---

## REST API (backend)

- `POST /api/start-monitoring`
- `POST /api/stop-monitoring`
- `GET /api/status?cluster=...&owner=...`
- `POST /api/prepare-buy` → returns unsigned tx (base64)
- `POST /api/prepare-sell` → returns unsigned tx (base64)
- `POST /api/prepare-bundle` → accepts **signed** txs (base64), simulates, returns a **local bundleId**
- `POST /api/submit-bundle` → submits prepared bundle to Jito, polls once, returns send result
- `GET /api/jito-tip-accounts`

---

## Deployment

### Frontend → Vercel

- Import repo
- Set **Root Directory** to `frontend`
- Add env vars:
  - `NEXT_PUBLIC_BACKEND_URL` = your backend URL
  - `NEXT_PUBLIC_CLUSTER` = `mainnet-beta` (production)
  - `NEXT_PUBLIC_RPC_URL` (optional; UI uses wallet adapter connection provider)

### Backend → Render

- Create a Web Service
- Set **Root Directory** to `backend`
- Build command: `npm install`
- Start command: `npm run start`
- Set env vars from `backend/.env.example`

---

## Risk & safety warnings

- Use a **burner wallet** first.
- Sniping/MEV strategies can lose funds quickly due to:
  - Rapid price impact / rug pulls
  - Bundle drops / partial fills
  - RPC / block engine latency
  - Incorrect pool parsing
- Always simulate and limit exposure. Keep max bundle tx count small (commonly **≤5**).

---

## License

MIT (add your preferred license).

