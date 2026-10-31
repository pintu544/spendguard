import { resolve } from "node:path";
import { formatYoctoAsNear } from "./amount.js";
import type { RuleId } from "./engine.js";
import { dayKey, readVerdictLog, type VerdictLogEntry } from "./log.js";

/**
 * Daily spend report (DESIGN.md component 5): a deterministic aggregation
 * of the verdict log for one UTC day. No model judgement anywhere — the
 * numbers are computed, and any narration happens elsewhere.
 */

export interface DailyReport {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  proposals: number;
  allowed: number;
  denied: number;
  escalated: number;
  /** ALLOW verdicts that actually executed on testnet (subset of allowed). */
  executed: number;
  /** Sum of the day's ALLOWed amounts, yoctoNEAR. */
  totalAllowedYocto: bigint;
  byRule: Partial<Record<RuleId, number>>;
}

export function buildDailyReport(entries: VerdictLogEntry[], date: string): DailyReport {
  const report: DailyReport = {
    date,
    proposals: 0,
    allowed: 0,
    denied: 0,
    escalated: 0,
    executed: 0,
    totalAllowedYocto: 0n,
    byRule: {},
  };
  for (const entry of entries) {
    if (dayKey(entry.ts) !== date) continue;
    report.proposals += 1;
    report.byRule[entry.ruleId] = (report.byRule[entry.ruleId] ?? 0) + 1;
    if (entry.decision === "ALLOW") {
      report.allowed += 1;
      report.totalAllowedYocto += BigInt(entry.proposal.amountYocto);
      if (entry.executed) report.executed += 1;
    } else if (entry.decision === "DENY") {
      report.denied += 1;
    } else {
      report.escalated += 1;
    }
  }
  return report;
}

export function renderDailyReport(report: DailyReport): string {
  const ruleLines = (Object.entries(report.byRule) as [RuleId, number][])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rule, count]) => `  ${rule}: ${count}`)
    .join("\n");
  return [
    `SpendGuard daily report — ${report.date} (UTC)`,
    `  Proposals:        ${report.proposals}`,
    `  Allowed:          ${report.allowed} (${report.executed} executed on testnet)`,
    `  Denied:           ${report.denied}`,
    `  Escalated:        ${report.escalated}`,
    `  Total allowed:    ${formatYoctoAsNear(report.totalAllowedYocto)} NEAR`,
    `  Verdicts by rule:`,
    ruleLines || "  (none)",
  ].join("\n");
}

async function main(): Promise<void> {
  const logPath =
    (process.env.SPENDGUARD_LOG_PATH ?? "").trim() || resolve(process.cwd(), "logs/verdicts.jsonl");
  const date = process.argv[2] ?? dayKey(new Date().toISOString());
  const entries = readVerdictLog(logPath);
  if (entries.length === 0) {
    console.log(`No verdict log at ${logPath} yet — run the demo first (npm run demo:dry).`);
    return;
  }
  console.log(renderDailyReport(buildDailyReport(entries, date)));
  console.log(`(from ${logPath})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
