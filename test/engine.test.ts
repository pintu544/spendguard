import { describe, expect, it } from "vitest";
import { evaluateProposal } from "../src/engine.js";
import { parsePolicy, type Policy } from "../src/policy.js";

const NEAR = 10n ** 24n;

// per-tx cap 1 NEAR, daily cap 2 NEAR, escalate above 0.5 NEAR.
const policy: Policy = parsePolicy({
  perTxCap: "1",
  dailyCap: "2",
  largePaymentThreshold: "0.5",
  allowlist: ["api-vendor.testnet", "data-feed.testnet"],
});

describe("evaluateProposal — happy path and boundaries", () => {
  it("ALLOWs a payment inside every rule", () => {
    const v = evaluateProposal(policy, { recipient: "api-vendor.testnet", amountNear: "0.25" }, 0n);
    expect(v.decision).toBe("ALLOW");
    expect(v.ruleId).toBe("PASS");
  });

  it("ALLOWs a payment exactly at the large-payment threshold (R4 fires only above it)", () => {
    const v = evaluateProposal(policy, { recipient: "api-vendor.testnet", amountNear: "0.5" }, 0n);
    expect(v.decision).toBe("ALLOW");
    expect(v.ruleId).toBe("PASS");
  });

  it("ALLOWs a payment that exactly reaches the daily cap (R3 fires only above it)", () => {
    const spent = (7n * NEAR) / 4n; // 1.75 NEAR
    const v = evaluateProposal(policy, { recipient: "api-vendor.testnet", amountNear: "0.25" }, spent);
    expect(v.decision).toBe("ALLOW");
    expect(v.details.projectedTodayYocto).toBe((2n * NEAR).toString());
  });

  it("does NOT deny a payment exactly at the per-tx cap under R2 — it escalates under R4 instead", () => {
    // R2's boundary is ">" the cap: exactly-at-cap passes R2. With the demo
    // policy the escalate threshold sits below the cap, so R4 is what fires.
    const v = evaluateProposal(policy, { recipient: "api-vendor.testnet", amountNear: "1" }, 0n);
    expect(v.decision).toBe("ESCALATE");
    expect(v.ruleId).toBe("R4_LARGE_PAYMENT");
  });

  it("carries the exact numbers used in the verdict details", () => {
    const v = evaluateProposal(policy, { recipient: "api-vendor.testnet", amountNear: "0.25" }, NEAR / 2n);
    expect(v.details.recipient).toBe("api-vendor.testnet");
    expect(v.details.amountYocto).toBe((NEAR / 4n).toString());
    expect(v.details.perTxCapYocto).toBe(NEAR.toString());
    expect(v.details.dailyCapYocto).toBe((2n * NEAR).toString());
    expect(v.details.spentTodayYocto).toBe((NEAR / 2n).toString());
  });
});

describe("evaluateProposal — R1 allowlist", () => {
  it("DENYs a non-allowlisted recipient", () => {
    const v = evaluateProposal(policy, { recipient: "mallory.testnet", amountNear: "0.1" }, 0n);
    expect(v.decision).toBe("DENY");
    expect(v.ruleId).toBe("R1_ALLOWLIST");
  });

  it("R1 wins over R2: an over-cap payment to a stranger is still R1 (rule order)", () => {
    const v = evaluateProposal(policy, { recipient: "mallory.testnet", amountNear: "50" }, 0n);
    expect(v.decision).toBe("DENY");
    expect(v.ruleId).toBe("R1_ALLOWLIST");
  });
});

describe("evaluateProposal — R2 per-transaction cap", () => {
  it("DENYs a payment above the per-tx cap to an allowlisted recipient", () => {
    const v = evaluateProposal(policy, { recipient: "api-vendor.testnet", amountNear: "1.1" }, 0n);
    expect(v.decision).toBe("DENY");
    expect(v.ruleId).toBe("R2_PER_TX_CAP");
  });
});

describe("evaluateProposal — R3 daily cap", () => {
  it("DENYs when amount + spent today crosses the daily cap", () => {
    const spent = (19n * NEAR) / 10n; // 1.9 NEAR
    const v = evaluateProposal(policy, { recipient: "api-vendor.testnet", amountNear: "0.25" }, spent);
    expect(v.decision).toBe("DENY");
    expect(v.ruleId).toBe("R3_DAILY_CAP");
  });

  it("DENYs the second payment of a day when it is the one that crosses the cap", () => {
    const first = evaluateProposal(policy, { recipient: "api-vendor.testnet", amountNear: "0.4" }, NEAR + NEAR / 2n);
    expect(first.decision).toBe("ALLOW"); // 1.5 + 0.4 = 1.9 <= 2
    const spentAfterFirst = NEAR + NEAR / 2n + (4n * NEAR) / 10n; // 1.9 NEAR
    const second = evaluateProposal(policy, { recipient: "api-vendor.testnet", amountNear: "0.25" }, spentAfterFirst);
    expect(second.decision).toBe("DENY");
    expect(second.ruleId).toBe("R3_DAILY_CAP");
  });
});

describe("evaluateProposal — R4 escalation band", () => {
  it("ESCALATEs a payment above the large-payment threshold but within the caps", () => {
    const v = evaluateProposal(policy, { recipient: "data-feed.testnet", amountNear: "0.75" }, 0n);
    expect(v.decision).toBe("ESCALATE");
    expect(v.ruleId).toBe("R4_LARGE_PAYMENT");
  });
});

describe("evaluateProposal — R0 malformed", () => {
  const malformed: [string, unknown][] = [
    ["null proposal", null],
    ["undefined proposal", undefined],
    ["string proposal", "pay 5 NEAR"],
    ["empty object", {}],
    ["missing amount", { recipient: "api-vendor.testnet" }],
    ["missing recipient", { amountNear: "0.1" }],
    ["empty recipient", { recipient: "  ", amountNear: "0.1" }],
    ["non-string recipient", { recipient: 42, amountNear: "0.1" }],
    ["non-numeric amount", { recipient: "api-vendor.testnet", amountNear: "five" }],
    ["negative amount", { recipient: "api-vendor.testnet", amountNear: "-5" }],
    ["zero amount", { recipient: "api-vendor.testnet", amountNear: "0" }],
    ["numeric (non-string) amount", { recipient: "api-vendor.testnet", amountNear: 5 }],
  ];
  it.each(malformed)("DENYs %s with R0_MALFORMED", (_label, proposal) => {
    const v = evaluateProposal(policy, proposal as never, 0n);
    expect(v.decision).toBe("DENY");
    expect(v.ruleId).toBe("R0_MALFORMED");
  });
});
