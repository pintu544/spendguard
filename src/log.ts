import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Decision, RuleId } from "./engine.js";

/**
 * The append-only verdict log (DESIGN.md component 5): one JSON object per
 * line (JSONL) — timestamp, proposal, verdict, rule id, and the transaction
 * hash when a payment actually executed. Every SpendGuard claim is auditable
 * from this file, and the daily report / spent-today totals are computed
 * from it deterministically.
 */

export interface VerdictLogEntry {
  /** ISO-8601 timestamp of the verdict. */
  ts: string;
  /** Demo scenario id ("S1"…), when the entry came from the scripted agent. */
  scenario?: string;
  proposal: {
    recipient: string;
    /** Human NEAR decimal string as proposed. */
    amountNear: string;
    /** Exact yoctoNEAR decimal string. */
    amountYocto: string;
  };
  decision: Decision;
  ruleId: RuleId;
  reason: string;
  /** The explainer's plain-English sentence for this verdict. */
  explanation: string;
  /** True only when release() executed on testnet and returned a tx hash. */
  executed: boolean;
  /** True when the run evaluated + logged without signing anything. */
  dryRun: boolean;
  txHash?: string;
  explorerUrl?: string;
}

/** Days are UTC days: the ISO date prefix of the timestamp. Deterministic on any machine. */
export function dayKey(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

export function appendVerdictLog(path: string, entry: VerdictLogEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

function hasRequiredShape(parsed: unknown): parsed is VerdictLogEntry {
  if (typeof parsed !== "object" || parsed === null) return false;
  const e = parsed as Record<string, unknown>;
  if (typeof e.ts !== "string" || !e.ts) return false;
  if (typeof e.decision !== "string" || !e.decision) return false;
  const p = e.proposal;
  if (typeof p !== "object" || p === null) return false;
  const amountYocto = (p as Record<string, unknown>).amountYocto;
  if (typeof amountYocto !== "string" || !amountYocto) return false;
  return true;
}

export function readVerdictLog(path: string): VerdictLogEntry[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const entries: VerdictLogEntry[] = [];
  lines.forEach((line, idx) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Verdict log ${path} line ${idx + 1} is not valid JSON — refusing to guess.`);
    }
    if (!hasRequiredShape(parsed)) {
      console.warn(`Verdict log ${path} line ${idx + 1}: missing required fields (ts, decision, proposal.amountYocto) — skipped.`);
      return;
    }
    entries.push(parsed);
  });
  return entries;
}

/**
 * Today's allowed total: the sum of amounts of entries whose verdict was
 * ALLOW on the same UTC day as `now`. This is the figure rule R3 checks —
 * only allowed payments consume the daily cap; DENY consumes nothing and an
 * ESCALATE is not an allowance until a human approves it out-of-band.
 */
export function spentTodayYocto(entries: VerdictLogEntry[], now: Date): bigint {
  const today = dayKey(now.toISOString());
  let total = 0n;
  for (const entry of entries) {
    if (entry.decision === "ALLOW" && entry.executed === true && dayKey(entry.ts) === today) {
      total += BigInt(entry.proposal.amountYocto);
    }
  }
  return total;
}

/**
 * Acquire an exclusive advisory lock at `lockPath`, run `fn`, then release.
 * Uses O_CREAT|O_EXCL (atomic on POSIX) with 50 ms retry up to `timeoutMs`.
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs: number = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      writeFileSync(lockPath, "", { flag: "wx" });
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() >= deadline) {
        throw new Error(`Could not acquire lock ${lockPath} within ${timeoutMs} ms — another process may be stuck.`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    try { unlinkSync(lockPath); } catch { /* best-effort release */ }
  }
}
