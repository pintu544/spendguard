# SpendGuard

**A deterministic policy firewall between an AI agent and its NEAR wallet.**

Every payment an agent proposes is checked against rules the human set — per-transaction cap, daily cap, recipient allowlist, and a large-payment band that escalates to a human. Only payments that pass ever get signed, and every verdict (ALLOW / DENY / ESCALATE) is recorded with the exact rule that fired and the numbers it used. No model judgement is involved in any verdict; the optional explainer only turns finished verdicts into plain-English sentences.

Built for the **NEAR Hackathon: Build Beyond Boundaries** — tracks `security` (AI Security & Defense) and `agents` (Agent Economy).

> **Honesty lines, up front:** this is a **testnet-only** prototype. It runs on NEAR testnet with free faucet funds — no mainnet, no real money, ever. Hackathon prizes for this event are paid in **NEAR tokens**, not cash.

## Why a guard contract? (the Gate 1 design note)

SpendGuard's first design had the agent's scoped key call a token contract's `ft_transfer` directly. The spike proved that is **protocol-impossible**: NEAR forbids attaching any deposit to a call signed by a function-call access key (`DepositWithFunctionCall`), and `ft_transfer` requires exactly 1 yoctoNEAR attached — asset-moving methods are full-access-only *by design*.

So the execution layer is a minimal **guard contract** (`contract/`): it holds a small testnet balance and exposes one **non-payable** method, `release(to, amount)`, which pays out of the *contract's* balance. The caller attaches nothing, so a scoped key can sign it. The policy then exists **three times**:

1. **Policy engine** (off-chain, deterministic TypeScript) — decides ALLOW / DENY / ESCALATE before anything is attempted.
2. **Scoped function-call access key** (protocol) — the agent's key can call only `release` on the guard contract, with an allowance; NEAR itself rejects anything else.
3. **Guard contract** (on-chain) — `release` accepts calls only from the agent account and enforces its own per-call cap, so even a compromised agent key cannot exceed it.

The human's full-access key is used once — deploy + fund + create the scoped key, via `npm run deploy:guard` on the human's machine — and never touches the agent process afterwards.

## NEAR pieces used

- **Function-call access keys** — scoped, allowance-capped keys native to NEAR accounts (the agent's only key).
- **A minimal near-sdk-js contract** — `contract/` (`init`, `release`, `getConfig`), compiled WASM committed at `contract/build/contract.wasm`.
- **near-api-js v7** — all account/key/contract interaction from TypeScript.
- **NEAR testnet** — RPC `https://rpc.testnet.near.org`; transactions are viewable on https://testnet.nearblocks.io.

## Reproduce it (do X — see Y)

You need Node.js 20+ and git. No NEAR account is needed for the dry run (step 3); the live run (step 5) needs a testnet account — step 4 sets everything up.

### 1. Install

```bash
git clone https://github.com/pintu544/spendguard.git
cd spendguard
npm ci
```

**See:** dependencies installed (near-api-js 7.4.0). No build step — everything runs via `tsx`.

### 2. Run the tests

```bash
npm test
```

**See:** 9 test files, **85 tests, all passing** — the engine rule-by-rule (including the boundaries: exactly-at-cap is not denied, a payment that exactly reaches the daily cap is allowed, the second payment that crosses it is denied), policy validation, executor refusal of non-ALLOW verdicts, and the guard contract's guard logic.

### 3. Run the demo dry (no account, no keys, signs nothing)

```bash
npm run demo:dry
```

**See:** the demo runs against `policy.example.json` (per-tx cap 1 NEAR, daily cap 2 NEAR, escalate above 0.5 NEAR) and prints three verdicts:

- **S1** — pay 0.25 NEAR to `api-vendor.testnet` (allowlisted) → **ALLOW** (rule `PASS`), marked as a dry run.
- **S2** — pay 1.1 NEAR to `api-vendor.testnet` → **DENY** (rule `R2_PER_TX_CAP`), nothing signed.
- **S3** — pay 0.25 NEAR to `unlisted-vendor.testnet` → **DENY** (rule `R1_ALLOWLIST`), nothing signed.

Each verdict comes with a one-sentence explanation, and all three are appended to the verdict log at `logs/verdicts.jsonl`. Then:

```bash
npm run report
```

**See:** the daily report computed from that log (3 proposals, 1 allowed, 2 denied, 0.25 NEAR total allowed). A sample log from a dry run is committed at `logs/sample-verdicts.jsonl`.

### 4. Set up the live demo (testnet account + deploy)

Follow **RUNBOOK-DEPLOY.md**: create a testnet account, fill `.env`, run `npm run deploy:guard` (deploys the guard contract, initialises it with your policy's per-tx cap, funds it, and creates the release-scoped key), and save the two printed keys into `.env`. Edit `policy.json` (copy of `policy.example.json`) with your real caps and your allowlist — the demo scenarios derive their amounts from your policy, so they demonstrate the same three verdicts whatever caps you choose.

### 5. Run the demo live

```bash
npm run demo
```

**See:** S1 now executes for real on testnet — the output prints the **transaction hash** and its NearBlocks explorer link (open it: a `release` call on the guard contract, signed by the scoped key, no deposit attached). S2 and S3 print DENY verdicts and sign nothing — the log entry for each shows `"executed":false` and no `txHash`, which you can verify in `logs/verdicts.jsonl`.

## How it works

```
policy.json + proposal → engine verdict (+ rule) → ALLOW → executor signs release() via scoped key
                                                    → testnet tx → verdict log → explainer sentence
                       DENY / ESCALATE stop at the log; nothing is signed.
```

| File | What it is |
| --- | --- |
| `src/policy.ts` | Policy types + strict JSON loader (refuses to start on an invalid policy, naming the exact field). |
| `src/engine.ts` | The deterministic verdict engine: rules R0–R4, pure functions, verdicts carry the rule + numbers used. |
| `src/executor.ts` | Executes ALLOW verdicts only — `release()` via the scoped key, no deposit; `dryRun` mode signs nothing. |
| `src/agent.ts` | The scripted demo agent (S1–S3) — `npm run demo` / `npm run demo:dry`. |
| `src/explainer.ts` | Verdict → one plain-English sentence (deterministic template; presentation only, never decides). |
| `src/log.ts` | The append-only JSONL verdict log + spent-today totals. |
| `src/report.ts` | Daily spend report computed from the log — `npm run report`. |
| `contract/` | The guard contract (near-sdk-js) and its README. |
| `scripts/deploy-guard.ts` | One-time live setup — `npm run deploy:guard` (see RUNBOOK-DEPLOY.md). |
| `src/spike/` | The Gate 1 spike that produced the design note above (kept for provenance). |

Rules, in evaluation order: **R0** malformed proposal → DENY · **R1** recipient not in allowlist → DENY · **R2** amount > per-transaction cap → DENY · **R3** amount + today's allowed total > daily cap → DENY · **R4** amount > large-payment threshold → ESCALATE (a human decides; never auto-signed) · otherwise **ALLOW**.

## Security notes

- No secrets in this repo: keys live in a gitignored `.env` only. The full-access key is used once by the deploy script on the human's machine; the demo process holds only the scoped key.
- Days in the log/report are UTC days.
- The guard contract's balance is the absolute ceiling on what SpendGuard can ever pay out; top it up (or don't) with a plain transfer to the contract account.

## License

MIT — see `LICENSE`.
