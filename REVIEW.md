# SpendGuard — Adversarial Code & Security Review

**Reviewer:** Claude (automated)
**Date:** 2026-11-24
**Scope:** Full codebase — `src/`, `contract/`, `scripts/`, `test/`, configuration files
**Test suite:** 85/85 passing, typecheck clean

---

## Architecture summary

SpendGuard is a deterministic policy firewall between an AI agent and a NEAR testnet wallet. Three independent enforcement layers:

1. **Off-chain policy engine** (`src/engine.ts`) — rules R0–R4, pure functions, no I/O
2. **Scoped function-call access key** (NEAR protocol) — agent key calls only `release` on the guard contract
3. **Guard contract** (`contract/`) — per-call cap + caller check, non-payable `release` method

Supporting components: policy loader, executor, verdict log (JSONL), daily report, template explainer, demo agent, deploy script.

---

## Findings

### F1 — MEDIUM: Daily cap counts dry-run ALLOWs as real spending

**File:** `src/log.ts:73`
**Concrete failure:** Run `npm run demo:dry` then `npm run demo` on the same UTC day. The dry-run S1 ALLOW (0.25 NEAR) is counted by `spentTodayYocto` toward the daily cap, even though no money moved. After ~7 dry runs with the default policy (dailyCap 2 NEAR, S1 amount 0.25 NEAR), the 8th run's S1 is denied by R3 — the daily cap is exhausted by phantom spending.

```typescript
// src/log.ts:73 — counts ALL ALLOWs, ignoring `executed` and `dryRun` fields
  if (entry.decision === "ALLOW" && dayKey(entry.ts) === today) {
    total += BigInt(entry.proposal.amountYocto);
  }
```

The log entries carry `executed: boolean` and `dryRun: boolean` fields but `spentTodayYocto` ignores them. This is fail-safe (overcounts, never undercounts) but it means dry runs degrade the live demo's daily budget. The RUNBOOK-DEPLOY.md does warn about accumulated ALLOWs, but the root cause is that dry-run verdicts inflate real spending totals.

**Fix:** Filter on `entry.executed === true` (or at minimum `entry.dryRun !== true`) in `spentTodayYocto`. Alternatively, write dry-run entries to a separate log path.

---

### F2 — MEDIUM: No file locking on verdict log — concurrent agents can exceed daily cap

**Files:** `src/log.ts:43-46`, `src/agent.ts:102-151`

**Concrete failure:** Two agent processes start simultaneously on a fresh day with dailyCap 2 NEAR. Both read the log, both see spentToday = 0, both evaluate a 1.5 NEAR payment as ALLOW (1.5 + 0 ≤ 2). Both execute. Total spending: 3 NEAR, exceeding the 2 NEAR daily cap. The guard contract has no daily cap — only a per-call cap — so both transactions succeed on-chain.

The verdict log uses `appendFileSync` (atomic at the OS level for small writes) but there is no read-evaluate-append lock. The TOCTOU window between reading spentToday and appending the ALLOW entry is unguarded.

This is acceptable for a single-process testnet demo but would be a security gap in any multi-agent or production deployment.

**Fix:** Use an advisory file lock (e.g., `flock`) around the read-evaluate-append cycle, or move daily cap enforcement on-chain.

---

### F3 — LOW: Policy allows `dailyCap < perTxCap` without warning
**File:** `src/policy.ts:73-81`
**Concrete failure:** A user sets `perTxCap: "10"` and `dailyCap: "1"`. The per-tx cap is now meaningless — every transaction under it still hits R3 on a fresh day if it exceeds 1 NEAR. The policy loader validates `largePaymentThreshold < perTxCap` but not `perTxCap <= dailyCap`. Not a vulnerability (R3 catches it, fail-safe) but a confusing misconfiguration the validator should reject or warn about.

**Fix:** Add a check: `if (perTxCapYocto > dailyCapYocto) throw new PolicyValidationError(...)` or at minimum log a warning.

---

### F4 — LOW: `NEAR_ACCOUNT_ID` not format-validated in config loader

**File:** `src/config.ts:58-61`
**Concrete failure:** Setting `NEAR_ACCOUNT_ID="not a valid account!!!"` passes the config loader (it only checks non-empty). The malformed ID propagates to `Account()` construction and RPC calls, producing an opaque chain-layer error instead of a clear startup refusal.

The policy loader validates allowlist entries against an account-ID regex. The config loader doesn't apply the same check to the agent's own account ID.

**Fix:** Validate `accountId` against the same `ACCOUNT_ID_RE` (or `isValidAccountId` from contract validation) in `parseConfig`.

---

### F5 — LOW: Verdict log entries not shape-validated on read

**File:** `src/log.ts:55`
**Concrete failure:** A corrupted or hand-edited log line like `{"ts":"2026-01-01","decision":"ALLOW"}` (missing `proposal.amountYocto`) passes `JSON.parse` but causes `BigInt(undefined)` → `SyntaxError` crash in `spentTodayYocto`. The error message is unhelpful ("Cannot convert undefined to a BigInt").

```typescript
entries.push(JSON.parse(line) as VerdictLogEntry);  // no shape check
```

**Fix:** Validate required fields (`ts`, `decision`, `proposal.amountYocto`) on read, or wrap `BigInt()` calls in `spentTodayYocto` with a guard.

---

### F6 — LOW: Explainer switch has no `default` branch (runtime safety)

**File:** `src/explainer.ts:29-42`
**Concrete failure:** If a `Verdict` with an unexpected `ruleId` reaches the explainer at runtime (e.g., from a deserialized log entry or a future code change that adds a rule but forgets to update the explainer), `explain()` returns `undefined` despite the `string` return type. TypeScript's `noImplicitReturns` guards this at compile time but there is no runtime fallback.

**Fix:** Add a `default` case that returns a generic explanation or throws, e.g., `default: return \`Verdict: ${verdict.decision} (rule ${verdict.ruleId}) — ${verdict.reason}\`;`

---

### F7 — LOW: Policy allowlist lacks account-ID length validation

**File:** `src/policy.ts:37, 88-89`
**Concrete failure:** A 100-character string matching the character regex (e.g., `"a"` repeated) is accepted into the allowlist. NEAR account IDs must be 2–64 characters. The contract's `isValidAccountId` enforces length; the policy loader's `ACCOUNT_ID_RE` does not. Such an entry would never match a real NEAR account, silently wasting an allowlist slot.

**Fix:** Add length bounds to the regex or add an explicit length check: `if (entry.length < 2 || entry.length > 64)`.

---

## What was checked and found clean

| Area | Verdict | Notes |
|---|---|---|
| **Amount arithmetic** (`src/amount.ts`) | Clean | Exact bigint math throughout. No floating point. `parseNearToYocto` validates format before `nearToYocto`. `formatYoctoAsNear` handles zero, padding, trailing-zero stripping. Round-trips correctly. |
| **Engine rule logic** (`src/engine.ts`) | Clean | R0→R1→R2→R3→R4→ALLOW ordering correct, first-hit-wins. All boundary conditions tested (exactly-at-cap passes, one-above denies). Pure functions, no I/O, deterministic. |
| **Executor refusal discipline** (`src/executor.ts`) | Clean | Only ALLOW verdicts execute. DENY/ESCALATE throw `ExecutorRefusedError` before any chain call. Payment/verdict mismatch caught. Dry-run mode skips chain entirely. |
| **Contract guards** (`contract/src/validation.ts`) | Clean | Caller → amount → balance ordering. All pure functions, no SDK deps. `parseYocto` strict (digits only). `isValidAccountId` checks length 2–64. |
| **Contract non-payability** (`contract/src/contract.ts`) | Clean | `@call({})` defaults to non-payable; SDK panics on attached deposit. `@initialize({})` one-time-only. `requireInit: true`. |
| **Secret management** | Clean | No secrets in repo. `.env` gitignored. `.env.example` has blank values. Keys only in env vars. `keygen.mjs` refuses to overwrite existing `.env`. `.env` written in mode 0600. |
| **Testnet-only hard guard** (`src/config.ts:71-76`) | Clean | `parseConfig` throws on `NEAR_NETWORK != "testnet"`. No mainnet code path. |
| **XSS / injection** | N/A | CLI tool, no web frontend, no SQL. JSON log escapes control characters via `JSON.stringify`. Recipient strings in explainer output go to stdout and JSON — no HTML rendering. |
| **Dependency surface** | Clean | Runtime: `near-api-js`, `undici` (proxy). Dev: `tsx`, `vitest`, `typescript`, `@types/node`. No unnecessary deps. `npm audit` reports 0 vulnerabilities. |
| **Error messages** | Clean | Custom error classes (`PolicyValidationError`, `CredentialsNotConfiguredError`, `ExecutorRefusedError`) with precise messages naming the exact field or variable. No stack traces or internal state leaked to users. |
| **Test coverage** | Good | 85 tests across 9 files. Engine boundaries, policy validation, executor refusal, contract guards, config parsing, report aggregation, explainer determinism, access-key scoping. |
| **Deploy script** (`scripts/deploy-guard.ts`) | Clean | Verifies WASM exists, reads policy, creates account, deploys, inits, verifies config on-chain, creates scoped key. Prints keys to stdout by design (user copies to .env). |
| **Log/report aggregation** (`src/report.ts`) | Clean | Deterministic UTC-day aggregation. Counts by decision type and rule ID. `renderDailyReport` formats correctly. |
| **Dead code** | None found | Spike files (`src/spike/`) are retained for provenance per README. All exported functions are used. |
| **Broken routes** | None found | All `package.json` scripts resolve to existing files. `import.meta.url` guards work correctly with `tsx`. |
