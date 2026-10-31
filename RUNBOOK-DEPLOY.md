# SpendGuard — deploy + live demo runbook (for Pintu's machine)

**Why this runs on your machine:** chain writes (deploy, funding, key creation, the live S1 payment) are POSTs to NEAR RPC, and the Muse VM's network black-holes those. Your machine's network is fine — the Gate 1 spike already proved it (faucet funding, wrap, scoped-key creation all landed from here). This runbook is the build-day-1 step B0/B5: deploy the guard contract, wire the scoped key, run S1–S3 live.

Everything is **testnet only** — free faucet funds, no real money, no mainnet anything.

**Time:** ~15 minutes, most of it waiting for transactions.

---

## 0. Prerequisites

Node.js 20+ and git (check: `node -v`). You also need the testnet account you created for Gate 1 (its `.env` is already on this machine from the spike — the same account becomes the agent account; its full-access key is used once by the deploy, then never again by the demo).

## 1. Get the latest code

```bash
cd spendguard
git pull
npm ci
```

(First time on a fresh machine instead: `git clone https://github.com/pintu544/spendguard.git`.)

## 2. Your policy

```bash
cp policy.example.json policy.json
```

Edit `policy.json` if you want different numbers. The defaults are fine for the demo: per-tx cap `1` NEAR, daily cap `2` NEAR, escalate above `0.5` NEAR, allowlist `api-vendor.testnet` + `data-feed.testnet`. The demo scenarios derive their amounts from this file (S1 = half the threshold, S2 = cap + 0.1, S3 = a non-allowlisted id), so the three verdicts come out the same whatever caps you set. Note: S1 pays the *first allowlist entry* from the guard contract's balance — it does not need to be an account you own; the released testnet NEAR simply lands there.

## 3. `.env` — what must be in it

Start from the spike's `.env` (or copy `.env.example`). Variable **names** (values are yours; never share the values with anyone, including in chat):

| Variable | What it is |
| --- | --- |
| `NEAR_ACCOUNT_ID` | Your testnet agent account id (already set from the spike). |
| `NEAR_PRIVATE_KEY` | That account's full-access key, `ed25519:...` (already set from the spike). |
| `NEAR_NETWORK` | `testnet` (the code refuses anything else). |
| `NEAR_GUARD_CONTRACT_ID` | Set by you AFTER step 4 — the guard contract account id the deploy prints. |
| `NEAR_SCOPED_PRIVATE_KEY` | Set by you AFTER step 4 — the scoped key the deploy prints (shown once). |
| `NEAR_GUARD_PRIVATE_KEY` | Set by you AFTER step 4 — the guard account's full-access key (shown once; for redeploy/recovery — the demo never uses it). |

Optional knobs: `NEAR_GUARD_FUND_NEAR` (guard funding, default `2`), `NEAR_SCOPED_KEY_ALLOWANCE_NEAR` (scoped-key allowance, default `1`).

Keep `.env` at mode 600 (`chmod 600 .env`). It is gitignored; never commit it.

## 4. Deploy the guard contract

```bash
npm run deploy:guard
```

What it does, in order: creates the guard account (`guard.<your account>` if your account is a named one; otherwise a fresh implicit account) funded with 2 testnet NEAR → deploys the committed `contract/build/contract.wasm` → calls `init` with your account id and the policy's per-tx cap → reads `getConfig` back and verifies it → creates your account's function-call key scoped to `release` on the guard contract → prints the `.env` lines to save.

**Expected success markers, in order:**

```
SpendGuard guard deploy — testnet
  Agent account:   <your account id>
  Guard contract:  guard.<your account id>   (or a 64-char hex id for implicit accounts)
1. Guard account created — tx: https://testnet.nearblocks.io/txns/<hash>
2. Contract deployed — tx: https://testnet.nearblocks.io/txns/<hash>
3. init(agent, cap) called — tx: https://testnet.nearblocks.io/txns/<hash>
4. getConfig on-chain: {"agentAccountId":"<your account id>","perCallCap":"1000000000000000000000000"}
   Verified: stored agent + cap match the deploy inputs.
5. Scoped key created (release only, allowance 1000000000000000000000000 yocto) — tx: https://testnet.nearblocks.io/txns/<hash>
   On-chain permission: {"FunctionCall":{"allowance":"1000000000000000000000000","method_names":["release"],"receiver_id":"guard.<your account id>"}}
DEPLOY OK. Save these lines into .env ...
NEAR_GUARD_CONTRACT_ID=...
NEAR_SCOPED_PRIVATE_KEY=...
NEAR_GUARD_PRIVATE_KEY=...
```

The pass markers are **`Verified: stored agent + cap match`** (step 4), the **on-chain permission line** in step 5 (it must say `method_names":["release"]` and your guard contract as `receiver_id`), and **`DEPLOY OK`**.

**Copy the three printed lines into `.env` now** — the two private keys are shown once and are not stored anywhere else. (If you lose the scoped key, just re-run the deploy? No — re-running creates a *second* guard account world. If a key is lost, tell Muse; the recovery is a fresh deploy under a new guard id, which is a decision, not an accident.)

## 5. Sanity: dry demo

```bash
npm run demo:dry
```

**See:** S1 ALLOW, S2 DENY (`R2_PER_TX_CAP`), S3 DENY (`R1_ALLOWLIST`), nothing signed. (Uses `policy.json` automatically when it exists.)

## 6. Live demo

```bash
npm run demo
```

**Expected success markers:**

```
Mode: LIVE (testnet) — agent account <your account id>, guard contract guard.<your account id>
[S1] payment inside policy
  Agent proposes: pay 0.25 NEAR to api-vendor.testnet
  Verdict: ALLOW (rule PASS)
  ...
  Executed on testnet — tx hash: <hash>
  Explorer: https://testnet.nearblocks.io/txns/<hash>
[S2] ... Verdict: DENY (rule R2_PER_TX_CAP) ... Nothing signed.
[S3] ... Verdict: DENY (rule R1_ALLOWLIST) ... Nothing signed.
```

Open the S1 explorer link: it should show a call to `release` on the guard contract, from your account, with **no deposit attached**, transferring 0.25 NEAR out of the guard contract to the recipient. In `logs/verdicts.jsonl`, the S1 entry has `"executed":true` and a `txHash`; S2/S3 have `"executed":false` and no `txHash`.

Optionally: `npm run report` — the day's totals from the log.

## 7. Send back

Message back just these (hashes and ids are public testnet data — safe to share; keys are not, ever):

1. The **five deploy tx hashes** (steps 1–5; or just paste the whole deploy output minus the final `.env` block).
2. The **guard contract account id**.
3. The **live S1 tx hash** from step 6.
4. One word per step if anything differed: deploy ok/failed, demo ok/failed — with any error text pasted (errors are fine to share; keys and seed phrases are not).

## If something fails

- **`SpendGuard credentials not configured`** — `.env` missing or incomplete; the message names exactly which variable. Fix and re-run.
- **A step hangs for over a minute with no output** — network issue on this connection, not a code failure (same signature as the VM's block). Try another network (phone hotspot) and report the hang.
- **Deploy failed part-way** (e.g. account created, deploy failed) — do NOT just re-run: the guard account now exists and a re-run would try to create it again. Note which numbered step failed, send the output, and Muse will write the resume step.
- **S1 verdict is not ALLOW** — the verdict log from earlier runs counts toward today's daily cap (`spentToday`). Check `npm run report`; if today's allowed total plus 0.25 would cross the daily cap, that's R3 working as designed — say so in the send-back and Muse will advise (fresh day, higher daily cap in `policy.json`, or a clean log for the recording run).
