import { describe, expect, it } from "vitest";
import {
  CredentialsNotConfiguredError,
  RPC_URLS,
  parseConfig,
} from "../src/config.js";

const KEY = "ed25519:3whateverTestKeyMaterial";
const base = {
  NEAR_ACCOUNT_ID: "alice.testnet",
  NEAR_PRIVATE_KEY: "ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  NEAR_NETWORK: "testnet",
};

describe("parseConfig", () => {
  it("accepts a complete testnet config", () => {
    const cfg = parseConfig(base);
    expect(cfg.accountId).toBe("alice.testnet");
    expect(cfg.network).toBe("testnet");
    expect(cfg.rpcUrl).toBe("https://rpc.testnet.near.org");
  });

  it("fails cleanly, naming both variables, when nothing is set", () => {
    try {
      parseConfig({});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialsNotConfiguredError);
      const e = err as CredentialsNotConfiguredError;
      expect(e.missing).toEqual(["NEAR_ACCOUNT_ID", "NEAR_PRIVATE_KEY"]);
      expect(e.message).toContain("credentials not configured");
      expect(e.message).toContain(".env.example");
    }
  });

  it("names only the actually-missing variable", () => {
    expect(() => parseConfig({ NEAR_ACCOUNT_ID: "alice.testnet" })).toThrowError(
      /Missing: NEAR_PRIVATE_KEY/,
    );
  });

  it("rejects a private key that is not in ed25519:... form", () => {
    expect(() =>
      parseConfig({ ...base, NEAR_PRIVATE_KEY: "not-a-key" }),
    ).toThrowError(/ed25519:/);
  });

  it("refuses mainnet — SpendGuard is testnet-only", () => {
    expect(() => parseConfig({ ...base, NEAR_NETWORK: "mainnet" })).toThrowError(
      /testnet-only/,
    );
  });

  it("defaults the network to testnet", () => {
    const cfg = parseConfig({ NEAR_ACCOUNT_ID: "alice.testnet", NEAR_PRIVATE_KEY: KEY });
    expect(cfg.network).toBe("testnet");
    expect(cfg.rpcUrl).toBe(RPC_URLS.testnet);
  });

  it("honours a NEAR_RPC_URL override", () => {
    const cfg = parseConfig({
      ...base,
      NEAR_RPC_URL: "https://rpc.example.test",
    });
    expect(cfg.rpcUrl).toBe("https://rpc.example.test");
  });

  it("rejects a NEAR_ACCOUNT_ID that is too short (F4)", () => {
    expect(() => parseConfig({ ...base, NEAR_ACCOUNT_ID: "a" })).toThrowError(/not a valid NEAR account id/);
  });

  it("rejects a NEAR_ACCOUNT_ID that is too long (F4)", () => {
    expect(() => parseConfig({ ...base, NEAR_ACCOUNT_ID: "a".repeat(65) })).toThrowError(
      /not a valid NEAR account id/,
    );
  });

  it("rejects a NEAR_ACCOUNT_ID with uppercase letters (F4)", () => {
    expect(() => parseConfig({ ...base, NEAR_ACCOUNT_ID: "Alice.testnet" })).toThrowError(
      /not a valid NEAR account id/,
    );
  });

  it("rejects a NEAR_ACCOUNT_ID with characters outside the NEAR grammar (F4)", () => {
    expect(() => parseConfig({ ...base, NEAR_ACCOUNT_ID: "alice!.testnet" })).toThrowError(
      /not a valid NEAR account id/,
    );
  });

  it("accepts NEAR_ACCOUNT_IDs at the 2 and 64 character boundaries (F4)", () => {
    expect(parseConfig({ ...base, NEAR_ACCOUNT_ID: "ab" }).accountId).toBe("ab");
    const longest = "a".repeat(64);
    expect(parseConfig({ ...base, NEAR_ACCOUNT_ID: longest }).accountId).toBe(longest);
  });
});
