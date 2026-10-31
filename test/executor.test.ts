import { describe, expect, it, vi } from "vitest";
import {
  CredentialsNotConfiguredError,
  parseExecutorConfig,
} from "../src/config.js";
import { evaluateProposal } from "../src/engine.js";
import {
  Executor,
  ExecutorRefusedError,
  type ReleasePort,
} from "../src/executor.js";
import { parsePolicy, type Policy } from "../src/policy.js";

const NEAR = 10n ** 24n;
const policy: Policy = parsePolicy({
  perTxCap: "1",
  dailyCap: "2",
  largePaymentThreshold: "0.5",
  allowlist: ["api-vendor.testnet"],
});
const payment = { recipient: "api-vendor.testnet", amountYocto: NEAR / 4n };
const allowVerdict = evaluateProposal(policy, { recipient: "api-vendor.testnet", amountNear: "0.25" }, 0n);
const denyVerdict = evaluateProposal(policy, { recipient: "api-vendor.testnet", amountNear: "5" }, 0n);
const escalateVerdict = evaluateProposal(policy, { recipient: "api-vendor.testnet", amountNear: "0.75" }, 0n);

function stubPort() {
  return {
    release: vi.fn(async (_args: { contractId: string; to: string; amountYocto: bigint }) => ({
      txHash: "TxHashStub1111111111111111111111111111111111",
    })),
  } satisfies ReleasePort;
}

describe("Executor — refusal discipline", () => {
  it("refuses a DENY verdict before any chain call", async () => {
    const port = stubPort();
    const executor = new Executor({ guardContractId: "guard.agent.testnet", port });
    await expect(executor.execute(denyVerdict, payment)).rejects.toBeInstanceOf(ExecutorRefusedError);
    expect(port.release).not.toHaveBeenCalled();
  });

  it("refuses an ESCALATE verdict — escalations are never auto-signed", async () => {
    const port = stubPort();
    const executor = new Executor({ guardContractId: "guard.agent.testnet", port });
    await expect(
      executor.execute(escalateVerdict, { recipient: "api-vendor.testnet", amountYocto: (3n * NEAR) / 4n }),
    ).rejects.toBeInstanceOf(ExecutorRefusedError);
    expect(port.release).not.toHaveBeenCalled();
  });

  it("refuses when the payment does not match the verdict that was evaluated", async () => {
    const port = stubPort();
    const executor = new Executor({ guardContractId: "guard.agent.testnet", port });
    await expect(
      executor.execute(allowVerdict, { recipient: "api-vendor.testnet", amountYocto: NEAR / 2n }),
    ).rejects.toThrowError(/does not match the evaluated verdict/);
    expect(port.release).not.toHaveBeenCalled();
  });

  it("cannot be constructed live without a port", () => {
    expect(() => new Executor({ guardContractId: "guard.agent.testnet" })).toThrowError(/ReleasePort/);
  });
});

describe("Executor — execution paths", () => {
  it("dry-run returns without touching the port", async () => {
    const port = stubPort();
    const executor = new Executor({ guardContractId: "guard.agent.testnet", port, dryRun: true });
    const outcome = await executor.execute(allowVerdict, payment);
    expect(outcome).toEqual({ status: "dry-run" });
    expect(port.release).not.toHaveBeenCalled();
  });

  it("executes an ALLOW verdict through the port with the exact payment", async () => {
    const port = stubPort();
    const executor = new Executor({ guardContractId: "guard.agent.testnet", port });
    const outcome = await executor.execute(allowVerdict, payment);
    expect(outcome.status).toBe("executed");
    expect(outcome.txHash).toBe("TxHashStub1111111111111111111111111111111111");
    expect(outcome.explorerUrl).toContain("testnet.nearblocks.io/txns/TxHashStub");
    expect(port.release).toHaveBeenCalledTimes(1);
    expect(port.release.mock.calls[0][0]).toEqual({
      contractId: "guard.agent.testnet",
      to: "api-vendor.testnet",
      amountYocto: NEAR / 4n,
    });
  });
});

describe("parseExecutorConfig", () => {
  const base = {
    NEAR_ACCOUNT_ID: "agent.testnet",
    NEAR_PRIVATE_KEY: "ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    NEAR_SCOPED_PRIVATE_KEY: "ed25519:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    NEAR_NETWORK: "testnet",
  };

  it("derives guard.<agent> as the default guard contract for a named account", () => {
    const cfg = parseExecutorConfig(base);
    expect(cfg.guardContractId).toBe("guard.agent.testnet");
    expect(cfg.accountId).toBe("agent.testnet");
  });

  it("honours an explicit NEAR_GUARD_CONTRACT_ID", () => {
    const cfg = parseExecutorConfig({ ...base, NEAR_GUARD_CONTRACT_ID: "vault.agent.testnet" });
    expect(cfg.guardContractId).toBe("vault.agent.testnet");
  });

  it("fails cleanly when the scoped key is absent, naming exactly it", () => {
    const { NEAR_SCOPED_PRIVATE_KEY: _dropped, ...noScoped } = base;
    try {
      parseExecutorConfig(noScoped);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialsNotConfiguredError);
      expect((err as CredentialsNotConfiguredError).missing).toEqual(["NEAR_SCOPED_PRIVATE_KEY"]);
    }
  });

  it("refuses to derive a guard id for an implicit agent account", () => {
    const implicit = "0123456789abcdef".repeat(4);
    expect(() =>
      parseExecutorConfig({ ...base, NEAR_ACCOUNT_ID: implicit }),
    ).toThrowError(/NEAR_GUARD_CONTRACT_ID is not set/);
    const cfg = parseExecutorConfig({
      ...base,
      NEAR_ACCOUNT_ID: implicit,
      NEAR_GUARD_CONTRACT_ID: "guard.example.testnet",
    });
    expect(cfg.guardContractId).toBe("guard.example.testnet");
  });
});
