import { describe, expect, it } from "vitest";
import {
  assertReleaseAllowed,
  parseYocto,
  validateInitConfig,
  type ReleaseRequest,
} from "../contract/src/validation.js";

/**
 * Offline tests for the guard contract's pure validation layer
 * (contract/src/validation.ts). The on-chain wrapper (contract.ts) feeds
 * these functions near.predecessorAccountId() / near.accountBalance();
 * here those chain values are plain inputs, so every guard the contract
 * enforces is exercised without a chain.
 */

const ONE_NEAR = 10n ** 24n;
const AGENT = "agent.testnet";

const baseRequest: ReleaseRequest = {
  predecessorAccountId: AGENT,
  agentAccountId: AGENT,
  to: "vendor.testnet",
  amount: (ONE_NEAR / 10n).toString(), // 0.1 NEAR
  perCallCap: ONE_NEAR.toString(), // 1 NEAR cap
  contractBalance: 5n * ONE_NEAR, // contract holds 5 NEAR
};

describe("parseYocto", () => {
  it("parses decimal yocto strings to bigint", () => {
    expect(parseYocto("0", "amount")).toBe(0n);
    expect(parseYocto("1000000000000000000000000", "amount")).toBe(ONE_NEAR);
    expect(parseYocto("007", "amount")).toBe(7n);
  });

  it("rejects anything that is not a plain non-negative integer string", () => {
    for (const bad of ["", "1.5", "-1", "+1", "1e24", " 1", "1 ", "0x10", "abc"]) {
      expect(() => parseYocto(bad, "amount")).toThrowError(/non-negative integer/);
    }
  });
});

describe("validateInitConfig", () => {
  it("accepts a valid agent id and cap, normalising the cap string", () => {
    const cfg = validateInitConfig({ agentAccountId: AGENT, perCallCap: "01000000000000000000000000" });
    expect(cfg.agentAccountId).toBe(AGENT);
    expect(cfg.perCallCap).toBe(ONE_NEAR.toString());
  });

  it("rejects an agent id that is not a NEAR account id", () => {
    expect(() =>
      validateInitConfig({ agentAccountId: "Not An Account!", perCallCap: "1" }),
    ).toThrowError(/Invalid agentAccountId/);
  });

  it("rejects a zero cap — a guard that can release nothing is a misconfiguration", () => {
    expect(() =>
      validateInitConfig({ agentAccountId: AGENT, perCallCap: "0" }),
    ).toThrowError(/must be positive/);
  });

  it("rejects a non-numeric cap", () => {
    expect(() =>
      validateInitConfig({ agentAccountId: AGENT, perCallCap: "one-near" }),
    ).toThrowError(/non-negative integer/);
  });
});

describe("assertReleaseAllowed (the release guards, in order)", () => {
  it("happy path: authorised agent, amount within cap and balance → returns the parsed amount", () => {
    expect(assertReleaseAllowed(baseRequest)).toBe(ONE_NEAR / 10n);
  });

  it("rejects a caller who is not the authorised agent", () => {
    expect(() =>
      assertReleaseAllowed({ ...baseRequest, predecessorAccountId: "mallory.testnet" }),
    ).toThrowError(/restricted to the authorised agent/);
  });

  it("checks the caller before the cap — an unauthorised over-cap call reports the caller", () => {
    expect(() =>
      assertReleaseAllowed({
        ...baseRequest,
        predecessorAccountId: "mallory.testnet",
        amount: (2n * ONE_NEAR).toString(),
      }),
    ).toThrowError(/restricted to the authorised agent/);
  });

  it("rejects a zero amount", () => {
    expect(() => assertReleaseAllowed({ ...baseRequest, amount: "0" })).toThrowError(
      /must be positive/,
    );
  });

  it("rejects an amount over the per-call cap, even when the balance covers it", () => {
    expect(() =>
      assertReleaseAllowed({ ...baseRequest, amount: (2n * ONE_NEAR).toString() }),
    ).toThrowError(/exceeds the per-call cap/);
  });

  it("allows an amount exactly at the per-call cap (boundary)", () => {
    expect(
      assertReleaseAllowed({ ...baseRequest, amount: ONE_NEAR.toString() }),
    ).toBe(ONE_NEAR);
  });

  it("rejects an amount within the cap but above the contract balance", () => {
    expect(() =>
      assertReleaseAllowed({
        ...baseRequest,
        amount: ONE_NEAR.toString(),
        contractBalance: ONE_NEAR / 2n,
      }),
    ).toThrowError(/exceeds the contract balance/);
  });

  it("rejects a malformed amount before any guard decision", () => {
    expect(() => assertReleaseAllowed({ ...baseRequest, amount: "0.1" })).toThrowError(
      /non-negative integer/,
    );
  });

  it("rejects a recipient that is not a NEAR account id", () => {
    expect(() => assertReleaseAllowed({ ...baseRequest, to: "not a vendor!" })).toThrowError(
      /Invalid recipient/,
    );
  });
});
