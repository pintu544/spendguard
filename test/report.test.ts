import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  appendVerdictLog,
  readVerdictLog,
  spentTodayYocto,
  type VerdictLogEntry,
} from "../src/log.js";
import { buildDailyReport, renderDailyReport } from "../src/report.js";

const NEAR = 10n ** 24n;

function entry(partial: Partial<VerdictLogEntry> & { ts: string }): VerdictLogEntry {
  return {
    proposal: { recipient: "api-vendor.testnet", amountNear: "0.25", amountYocto: (NEAR / 4n).toString() },
    decision: "ALLOW",
    ruleId: "PASS",
    reason: "within policy",
    explanation: "Allowed: ...",
    executed: false,
    dryRun: true,
    ...partial,
  };
}

const entries: VerdictLogEntry[] = [
  entry({ ts: "2026-11-08T09:00:00.000Z", scenario: "S1", executed: true, dryRun: false, txHash: "abc" }),
  entry({
    ts: "2026-11-08T10:00:00.000Z",
    scenario: "S2",
    proposal: { recipient: "api-vendor.testnet", amountNear: "1.1", amountYocto: ((11n * NEAR) / 10n).toString() },
    decision: "DENY",
    ruleId: "R2_PER_TX_CAP",
  }),
  entry({
    ts: "2026-11-08T11:00:00.000Z",
    proposal: { recipient: "data-feed.testnet", amountNear: "0.75", amountYocto: ((3n * NEAR) / 4n).toString() },
    decision: "ESCALATE",
    ruleId: "R4_LARGE_PAYMENT",
  }),
  entry({ ts: "2026-11-09T09:00:00.000Z" }), // next day — excluded from the 8th's report
];

describe("buildDailyReport", () => {
  it("aggregates one UTC day deterministically", () => {
    const report = buildDailyReport(entries, "2026-11-08");
    expect(report.proposals).toBe(3);
    expect(report.allowed).toBe(1);
    expect(report.denied).toBe(1);
    expect(report.escalated).toBe(1);
    expect(report.executed).toBe(1);
    expect(report.totalAllowedYocto).toBe(NEAR / 4n);
    expect(report.byRule).toEqual({ PASS: 1, R2_PER_TX_CAP: 1, R4_LARGE_PAYMENT: 1 });
  });

  it("renders the totals in NEAR", () => {
    const text = renderDailyReport(buildDailyReport(entries, "2026-11-08"));
    expect(text).toContain("SpendGuard daily report — 2026-11-08 (UTC)");
    expect(text).toContain("Total allowed:    0.25 NEAR");
    expect(text).toContain("R2_PER_TX_CAP: 1");
  });

  it("an empty day reports zeros", () => {
    const report = buildDailyReport(entries, "2026-11-10");
    expect(report.proposals).toBe(0);
    expect(report.totalAllowedYocto).toBe(0n);
  });
});

describe("spentTodayYocto", () => {
  it("sums only today's ALLOW amounts (DENY/ESCALATE consume nothing)", () => {
    const now = new Date("2026-11-08T23:30:00.000Z");
    expect(spentTodayYocto(entries, now)).toBe(NEAR / 4n);
  });
});

describe("verdict log round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "spendguard-log-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("append + read preserves entries and creates directories", () => {
    const path = join(dir, "nested", "verdicts.jsonl");
    for (const e of entries) appendVerdictLog(path, e);
    const read = readVerdictLog(path);
    expect(read).toHaveLength(entries.length);
    expect(read[0]).toEqual(entries[0]);
    expect(read[1].ruleId).toBe("R2_PER_TX_CAP");
  });

  it("a missing log reads as empty", () => {
    expect(readVerdictLog(join(dir, "nope.jsonl"))).toEqual([]);
  });
});
