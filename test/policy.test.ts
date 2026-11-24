import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyValidationError, loadPolicy, parsePolicy } from "../src/policy.js";

const NEAR = 10n ** 24n;
const valid = {
  perTxCap: "1",
  dailyCap: "2",
  largePaymentThreshold: "0.5",
  allowlist: ["api-vendor.testnet"],
};

describe("parsePolicy — valid policies", () => {
  it("parses NEAR strings into exact yocto bigints", () => {
    const p = parsePolicy(valid);
    expect(p.perTxCapYocto).toBe(NEAR);
    expect(p.dailyCapYocto).toBe(2n * NEAR);
    expect(p.largePaymentThresholdYocto).toBe(NEAR / 2n);
    expect(p.allowlist).toEqual(["api-vendor.testnet"]);
  });

  it("loads the shipped policy.example.json from the repo root", () => {
    const p = loadPolicy(resolve(process.cwd(), "policy.example.json"));
    expect(p.perTxCapYocto).toBe(NEAR);
    expect(p.allowlist).toContain("api-vendor.testnet");
  });
});

describe("parsePolicy — validation failures refuse to start, naming the field", () => {
  it("rejects a non-object policy", () => {
    expect(() => parsePolicy("nope")).toThrowError(PolicyValidationError);
    expect(() => parsePolicy(null)).toThrowError(/must be a JSON object/);
  });

  it("rejects unknown fields (typo protection)", () => {
    expect(() => parsePolicy({ ...valid, perTxCp: "1" })).toThrowError(/unknown field/);
  });

  it("rejects a missing cap", () => {
    const { perTxCap: _dropped, ...rest } = valid;
    expect(() => parsePolicy(rest)).toThrowError(/"perTxCap" must be a NEAR amount string/);
  });

  it("rejects a non-string cap", () => {
    expect(() => parsePolicy({ ...valid, dailyCap: 2 })).toThrowError(/"dailyCap"/);
  });

  it("rejects an unparseable cap", () => {
    expect(() => parsePolicy({ ...valid, dailyCap: "two" })).toThrowError(/"dailyCap" is not a valid NEAR amount/);
  });

  it("rejects a zero cap", () => {
    expect(() => parsePolicy({ ...valid, perTxCap: "0" })).toThrowError(/"perTxCap" must be positive/);
  });

  it("rejects a threshold at or above the per-tx cap", () => {
    expect(() => parsePolicy({ ...valid, largePaymentThreshold: "1" })).toThrowError(
      /"largePaymentThreshold" must be below "perTxCap"/,
    );
    expect(() => parsePolicy({ ...valid, largePaymentThreshold: "3" })).toThrowError(
      /must be below "perTxCap"/,
    );
  });

  it("rejects an empty allowlist", () => {
    expect(() => parsePolicy({ ...valid, allowlist: [] })).toThrowError(/"allowlist" must be a non-empty array/);
  });

  it("rejects a non-array allowlist", () => {
    expect(() => parsePolicy({ ...valid, allowlist: "api-vendor.testnet" })).toThrowError(/non-empty array/);
  });

  it("rejects an allowlist entry that is not an account id", () => {
    expect(() => parsePolicy({ ...valid, allowlist: ["not an account!!"] })).toThrowError(
      /is not a NEAR account id/,
    );
  });

  it("rejects duplicate allowlist entries", () => {
    expect(() =>
      parsePolicy({ ...valid, allowlist: ["api-vendor.testnet", "api-vendor.testnet"] }),
    ).toThrowError(/twice/);
  });

  it("rejects a perTxCap larger than the dailyCap (F3)", () => {
    expect(() => parsePolicy({ ...valid, perTxCap: "3", dailyCap: "2" })).toThrowError(
      /must not exceed "dailyCap"/,
    );
  });

  it("accepts a perTxCap equal to the dailyCap (F3 boundary)", () => {
    const p = parsePolicy({ ...valid, perTxCap: "2", dailyCap: "2" });
    expect(p.perTxCapYocto).toBe(p.dailyCapYocto);
  });

  it("rejects an allowlist entry shorter than 2 characters (F7)", () => {
    expect(() => parsePolicy({ ...valid, allowlist: ["a"] })).toThrowError(/2–64 characters/);
  });

  it("rejects an allowlist entry longer than 64 characters (F7)", () => {
    expect(() => parsePolicy({ ...valid, allowlist: ["a".repeat(65)] })).toThrowError(/2–64 characters/);
  });

  it("accepts an allowlist entry at the 64 character boundary (F7)", () => {
    const longest = "a".repeat(64);
    const p = parsePolicy({ ...valid, allowlist: [longest] });
    expect(p.allowlist).toEqual([longest]);
  });

  it("loadPolicy names a missing file exactly", () => {
    expect(() => loadPolicy(resolve(process.cwd(), "policy.does-not-exist.json"))).toThrowError(
      /policy file not found/,
    );
  });
});
