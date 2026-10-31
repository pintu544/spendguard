/**
 * Spike step 1 (read-only): prove this machine can reach the NEAR testnet
 * RPC and read live chain state. Needs NO credentials.
 *
 * Run: npm run spike:rpc
 */
import { Account, JsonRpcProvider } from "near-api-js";
import { RPC_URLS } from "../config.js";
import { setupProxyFromEnv } from "../net.js";

async function main(): Promise<void> {
  const proxy = setupProxyFromEnv();
  if (proxy) console.log(`Routing RPC through proxy: ${proxy}`);
  const rpcUrl = RPC_URLS.testnet;
  console.log(`Connecting to NEAR testnet RPC: ${rpcUrl}`);
  const provider = new JsonRpcProvider({ url: rpcUrl });

  // Live chain state #1: the testnet root account, straight from the provider.
  const root = await provider.viewAccount({ accountId: "testnet" });
  console.log("viewAccount('testnet'):");
  console.log(`  amount (yoctoNEAR): ${root.amount}`);
  console.log(`  locked:             ${root.locked}`);
  console.log(`  storage_usage:      ${root.storage_usage}`);
  console.log(`  block_height:       ${(root as { block_height?: number }).block_height}`);
  console.log(`  block_hash:         ${(root as { block_hash?: string }).block_hash}`);

  // Live chain state #2: same read through the Account abstraction the
  // spike (and later executor) will use.
  const account = new Account("testnet", provider);
  const state = await account.getState();
  console.log("Account('testnet').getState():");
  console.log(`  balance total:  ${state.balance.total}`);
  console.log(`  balance locked: ${state.balance.locked}`);
  console.log("RPC PROOF OK — testnet reachable, live state read.");
}

main().catch((err: unknown) => {
  console.error("RPC PROBE FAILED:");
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
