import { Account, type Provider } from "near-api-js";
import { describe, expect, it, vi } from "vitest";

/**
 * Offline integration shape-check: near-api-js's Account must be drivable
 * with any Provider implementation. We stub the provider (no network, no
 * account) and confirm reads flow through it and map to account state —
 * the same surface the spike and later executor use against the real RPC.
 */
describe("Account with a mocked provider", () => {
  it("getState() reads through the injected provider", async () => {
    const viewAccount = vi.fn(async (_args: { accountId: string }) => ({
      amount: "5000000000000000000000000", // 5 NEAR in yocto
      locked: "0",
      code_hash: "11111111111111111111111111111111",
      storage_usage: 1000,
      block_height: 275_582_755,
      block_hash: "4XTwpavgEi8SozzqFY4pnYn25YpLeuF8Nf8Uo5ujHj6M",
    }));
    const experimental_protocolConfig = vi.fn(async () => ({
      runtime_config: { storage_amount_per_byte: "10000000000000000000" },
    }));
    const provider = { viewAccount, experimental_protocolConfig } as unknown as Provider;

    const account = new Account("alice.testnet", provider);
    const state = await account.getState();

    expect(viewAccount).toHaveBeenCalledTimes(1);
    expect(viewAccount.mock.calls[0][0]).toMatchObject({ accountId: "alice.testnet" });
    expect(String(state.balance.total)).toBe("5000000000000000000000000");
  });
});
