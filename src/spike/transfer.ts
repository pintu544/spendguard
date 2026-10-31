/**
 * Spike step 2: one testnet NEAR transfer from TypeScript (TASKS P2).
 *
 * Needs credentials in .env (see .env.example / spec/SPIKE.md). Without
 * them it exits immediately with a clear "credentials not configured"
 * message — run it to see exactly that.
 *
 * Usage:
 *   npm run spike:transfer -- <recipient.testnet> [amountNEAR]
 * or set NEAR_SPIKE_RECIPIENT / NEAR_SPIKE_AMOUNT_NEAR in .env.
 * Default amount: 0.01 NEAR (testnet — free faucet funds, not real money).
 */
import { Account, KeyPairSigner } from "near-api-js";
import { parseNearToYocto } from "../amount.js";
import { loadConfig } from "../config.js";
import { setupProxyFromEnv } from "../net.js";

async function main(): Promise<void> {
  setupProxyFromEnv();
  const config = loadConfig(); // throws CredentialsNotConfiguredError if .env absent

  const recipient = process.argv[2] ?? process.env.NEAR_SPIKE_RECIPIENT ?? "";
  const amountNear = process.argv[3] ?? process.env.NEAR_SPIKE_AMOUNT_NEAR ?? "0.01";
  if (!recipient) {
    throw new Error(
      "No recipient. Pass one as an argument: npm run spike:transfer -- <recipient.testnet> [amountNEAR]",
    );
  }

  const signer = KeyPairSigner.fromSecretKey(config.privateKey as `ed25519:${string}`);
  const account = new Account(config.accountId, config.rpcUrl, signer);

  const before = await account.getState();
  console.log(`Sender:   ${config.accountId}`);
  console.log(`Balance:  ${before.balance.total} yoctoNEAR`);
  console.log(`Sending:  ${amountNear} NEAR -> ${recipient} (testnet)`);

  const result = await account.transfer({
    receiverId: recipient,
    amount: parseNearToYocto(amountNear),
  });

  const hash = (result as { transaction?: { hash?: string } }).transaction?.hash;
  console.log("TRANSFER OK");
  if (hash) console.log(`Tx hash:  ${hash}\nExplorer: https://testnet.nearblocks.io/txns/${hash}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
