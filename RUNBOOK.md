# SpendGuard spike — runbook for Pintu's machine

**Why this runs on your machine:** the Muse VM's network black-holes
outbound POSTs (NEAR RPC writes and even the faucet API hang there — full
diagnosis in the project notes, `spec/SPIKE.md`). Your home network has no
such restriction. This is the Gate 1 spike check from the build plan: if
all three commands at the end pass, the SpendGuard entry proceeds; if the
access-key step fails, we stop and park it.

Everything below uses **testnet only** — free faucet funds, no real money,
no mainnet anything. (The mainnet payout address is only needed at
submission time in November and stays a separate manual step for then —
it's not part of this runbook.)

---

## 0. Prerequisites

You need Node.js 20+ and git. Check first:

```bash
node -v    # must print v20.x or higher (built/tested on v24)
npm -v
git --version
```

If Node is below 20, install the current LTS from https://nodejs.org
before continuing.

## 1. Get the code

```bash
git clone https://github.com/pintu544/spendguard.git
cd spendguard
npm ci
```

`npm ci` installs the exact locked dependency versions (near-api-js 7.4.0).
No build step — the spike scripts run via `tsx` / plain Node.

## 2. Create the testnet account + `.env` in one command

```bash
npm run spike:keygen
```

This mints a throwaway testnet account **on this machine**:

1. Generates a fresh ed25519 keypair locally.
2. Derives the account ID from it (a NEAR *implicit* account — the
   64-character hex of the public key; it exists on-chain once funded).
3. Writes `.env` with `NEAR_ACCOUNT_ID` / `NEAR_PRIVATE_KEY` /
   `NEAR_NETWORK=testnet`, file permissions 600. It **refuses to run if
   a `.env` already exists** — that's deliberate, so a key is never
   silently replaced.
4. Funds the account with **5 testnet NEAR** via the NEAR docs Faucet API.

**Expected output:**

```
Account id (implicit): <64 hex characters — your account ID>
.env written (permissions 600). The private key is in .env only — not printed here.
Requesting 5 testnet NEAR from the faucet…
Funding: OK (HTTP 200) — ...
```

**If the funding line says FAILED** (the faucet service cold-starts and
occasionally times out — retry the top-up once with):

```bash
curl -X POST https://docs-mcp-f18b.onrender.com/api/faucet \
  -H 'content-type: application/json' \
  -d '{"accountId":"<your account ID from the keygen output>"}'
```

Alternatives: the faucet form at
https://docs.near.org/getting-started/faucet, or https://near-faucet.io.
The account and `.env` already exist either way — only the top-up is
missing. You need roughly 2+ testnet NEAR before step 3.

> ## ⚠️ ABOUT THE KEY IN `.env`
>
> **`.env` now holds a TESTNET private key, minted on this machine. Keys
> are generated per-machine and never travel** — never copy this key to
> another machine or send it anywhere; any machine that runs the spike
> runs its own `spike:keygen` and gets its own account. **Never put a
> mainnet private key in this file**, and **never share any private key
> in chat, email, or any message** — not with Muse, not with anyone.
> `.env` is gitignored and must never be committed.

**Alternative (manual wallet route):** instead of keygen, you can create
a named testnet account (e.g. `yourname.testnet`) at
https://testnet.mynearwallet.com (seed-phrase recovery — back the phrase
up offline), export its full-access private key from the wallet
settings, and fill `.env` by copying `.env.example`. Same warnings apply.

## 3. Run the three spike commands — in this order

### 3a. RPC probe (no credentials needed)

```bash
npm run spike:rpc
```

**Expected success output** — live state read, ending with:

```
viewAccount('testnet'):
  amount (yoctoNEAR): ...
  locked:             ...
  storage_usage:      ...
  block_height:       ...
  block_hash:         ...
Account('testnet').getState():
  balance total:  ...
  balance locked: ...
RPC PROOF OK — testnet reachable, live state read.
```

The pass marker is the last line: **`RPC PROOF OK`**.

> **Troubleshooting — the one known non-failure:** if `spike:rpc`
> prints `Connecting to NEAR testnet RPC: https://rpc.testnet.near.org`
> and then hangs with no further output for over a minute, that is a
> **network issue on the machine/network you're on, not a code
> failure** (it's the same behaviour the Muse VM shows). Don't debug
> the code — try another network (e.g. phone hotspot) and, either way,
> report the hang when you send back results.

### 3b. One testnet transfer

```bash
npm run spike:transfer -- <your account ID> 0.01
```

(Use the account ID keygen printed. Sending 0.01 testnet NEAR to your
own account is the simplest target — any existing testnet account works
as the recipient.)

**Expected success output:**

```
Sender:   <your account ID>
Balance:  ... yoctoNEAR
Sending:  0.01 NEAR -> <your account ID> (testnet)
TRANSFER OK
Tx hash:  <a long hash>
Explorer: https://testnet.nearblocks.io/txns/<same hash>
```

The pass marker is **`TRANSFER OK`**. Keep the **Tx hash** — you send
it back in step 4.

### 3c. Scoped function-call access key (the core primitive)

```bash
npm run spike:access-key -- --mint-wrap 0.1
```

(The `--mint-wrap 0.1` first wraps 0.1 NEAR into wNEAR with your
full-access key, so the scoped key's transfer has a balance to move.)

**Expected success output, in order:**

```
Wrapping 0.1 NEAR into wNEAR (full-access key, testnet)…
Wrapped.
Adding function-call access key ed25519:...
  scope: contract=wrap.testnet methods=[ft_transfer] allowance=1000000000000000000000000 yoctoNEAR
On-chain permission for the new key:
  {"FunctionCall":{"allowance":"1000000000000000000000000","method_names":["ft_transfer"],"receiver_id":"wrap.testnet"}}
Calling ft_transfer with the scoped key only…
SCOPED CALL EXECUTED
Tx hash:  <a long hash>
Explorer: https://testnet.nearblocks.io/txns/<same hash>
Note: the scoped key's secret was generated in-memory for this spike run and not stored. ...
```

The pass markers are the **`On-chain permission`** JSON line (it must
say `wrap.testnet`, `ft_transfer`, allowance `1000000000000000000000000`
= 1 NEAR) and **`SCOPED CALL EXECUTED`**.

## 4. Send back

Message back just these two things:

1. The **transfer tx hash** (from step 3b — the line after `TRANSFER OK`).
2. The **"On-chain permission for the new key" line** (the JSON printed
   in step 3c).

Plus a one-word verdict per command if anything differed: rpc ok/hung,
transfer ok/failed, access-key ok/failed, with any error text pasted
(errors are fine to share — keys and seed phrases are not).

**Gate rule:** all three passing = the spike passes and the build days
(8–11 Nov) proceed. A failure at step 3c = stop, report it, and the
entry is parked.
