import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendVerdictLog,
  readVerdictLog,
  spentTodayYocto,
  withLock,
  type VerdictLogEntry,
} from "../src/log.js";

const NEAR = 10n ** 24n;
const NOW = new Date("2026-11-14T12:00:00.000Z");
const TODAY = "2026-11-14T08:30:00.000Z";
const YESTERDAY = "2026-11-13T23:30:00.000Z";

function entry(overrides: Partial<VerdictLogEntry> = {}): VerdictLogEntry {
  return {
    ts: TODAY,
    proposal: { recipient: "api-vendor.testnet", amountNear: "0.5", amountYocto: (NEAR / 2n).toString() },
    decision: "ALLOW",
    ruleId: "PASS",
    reason: "within policy",
    explanation: "Allowed.",
    executed: true,
    dryRun: false,
    ...overrides,
  };
}

describe("spentTodayYocto (F1: only executed ALLOWs consume the daily cap)", () => {
  it("counts an executed ALLOW from today", () => {
    expect(spentTodayYocto([entry()], NOW)).toBe(NEAR / 2n);
  });

  it("does NOT count a dry-run ALLOW (evaluated and logged, never signed)", () => {
    const dry = entry({ executed: false, dryRun: true });
    expect(spentTodayYocto([dry], NOW)).toBe(0n);
  });

  it("does NOT count an ALLOW whose executed flag is absent", () => {
    const e = entry();
    delete (e as Partial<VerdictLogEntry>).executed;
    expect(spentTodayYocto([e], NOW)).toBe(0n);
  });

  it("does NOT count DENY or ESCALATE verdicts, even from today", () => {
    const deny = entry({ decision: "DENY", ruleId: "R2_PER_TX_CAP", executed: false });
    const esc = entry({ decision: "ESCALATE", ruleId: "R4_LARGE_PAYMENT", executed: false });
    expect(spentTodayYocto([deny, esc], NOW)).toBe(0n);
  });

  it("does NOT count an executed ALLOW from a previous UTC day", () => {
    expect(spentTodayYocto([entry({ ts: YESTERDAY })], NOW)).toBe(0n);
  });

  it("sums multiple executed ALLOWs exactly (bigint)", () => {
    const a = entry();
    const b = entry({
      proposal: { recipient: "api-vendor.testnet", amountNear: "0.25", amountYocto: (NEAR / 4n).toString() },
    });
    expect(spentTodayYocto([a, b], NOW)).toBe((3n * NEAR) / 4n);
  });
});

describe("readVerdictLog (F5: malformed lines are skipped with a warning, never crash)", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spendguard-log-"));
    logPath = join(dir, "verdicts.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns [] when the log file does not exist", () => {
    expect(readVerdictLog(logPath)).toEqual([]);
  });

  it("round-trips entries written by appendVerdictLog", () => {
    appendVerdictLog(logPath, entry());
    appendVerdictLog(logPath, entry({ decision: "DENY", ruleId: "R1_ALLOWLIST", executed: false }));
    const read = readVerdictLog(logPath);
    expect(read).toHaveLength(2);
    expect(read[0]?.decision).toBe("ALLOW");
    expect(read[1]?.ruleId).toBe("R1_ALLOWLIST");
  });

  it("skips a JSON line that is missing required fields and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    appendVerdictLog(logPath, entry());
    writeFileSync(logPath, `${readFileSync(logPath, "utf8")}${JSON.stringify({ ts: TODAY })}\n`, "utf8");
    const read = readVerdictLog(logPath);
    expect(read).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips a JSON line whose proposal has no amountYocto and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = { ts: TODAY, decision: "ALLOW", proposal: { recipient: "api-vendor.testnet" } };
    writeFileSync(logPath, `${JSON.stringify(bad)}\n`, "utf8");
    expect(readVerdictLog(logPath)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips a non-object JSON line (a bare number) and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(logPath, "42\n", "utf8");
    expect(readVerdictLog(logPath)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("still refuses a line that is not valid JSON at all", () => {
    writeFileSync(logPath, "this is not json\n", "utf8");
    expect(() => readVerdictLog(logPath)).toThrowError(/not valid JSON/);
  });
});

describe("withLock (F2: advisory lockfile)", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spendguard-lock-"));
    lockPath = join(dir, "verdicts.lock");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs fn, returns its value, and releases the lock", async () => {
    const value = await withLock(lockPath, async () => 42);
    expect(value).toBe(42);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases the lock even when fn throws", async () => {
    await expect(
      withLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrowError(/boom/);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("times out when another holder never releases the lock", async () => {
    writeFileSync(lockPath, "", "utf8");
    await expect(withLock(lockPath, async () => 1, 200)).rejects.toThrowError(/Could not acquire lock/);
  });

  it("serialises concurrent holders: the second waits for the first to finish", async () => {
    const order: string[] = [];
    const first = withLock(lockPath, async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      order.push("first-end");
    });
    const second = withLock(lockPath, async () => {
      order.push("second");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});
