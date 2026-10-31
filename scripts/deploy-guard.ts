/**
 * SpendGuard guard-contract deploy (build-day-1 runbook step).
 *
 * Runs on a machine WITH network access to NEAR testnet (the dev VM cannot
 * POST to NEAR RPC — see RUNBOOK.md). Uses the agent account's FULL-ACCESS
 * key from .env exactly once, to set up the bounded world the agent then
 * lives in:
 *
 *   1. Create the guard contract account (subaccount `guard.<agent>` for a
 *      named agent account; a fresh implicit account otherwise), funded
 *      with NEAR_GUARD_FUND_NEAR (default 2 testnet NEAR).
 *   2. Deploy the committed contract/build/contract.wasm to it.
 *   3. Call init(agentAccountId, perCallCap) — the cap comes from the
 *      policy file, so the on-chain cap mirrors the off-chain per-tx cap.
 *   4. Read getConfig back and verify what the chain stored.
 *   5. Create the agent's function-call access key scoped to
 *      (guard contract, ["release"]) with an allowance — the ONLY key the
 *      agent process ever holds.
 *
 * The guard account's full-access key and the scoped key are generated
 * here and printed ONCE at the end, with the exact .env lines to save
 * them under. They are secrets: this script runs on the human's machine,
 * and the values go into the human's gitignored .env and nowhere else.
 *
 * Without .env it fails immediately with the standard
 * "SpendGuard credentials not configured" message — no network is touched.
 *
 * Usage: npm run deploy:guard [-- --policy policy.json]
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Account, KeyPairEd25519, KeyPairSigner } from "near-api-js";
import { parseNearToYocto } from "../src/amount.js";
import { loadConfig } from "../src/config.js";
import { setupProxyFromEnv } from "../src/net.js";
import { loadPolicy } from "../src/policy.js";

const IMPLICIT_ACCOUNT_RE = /^[0-9a-f]{64}$/;
const WASM_PATH = fileURLToPath(new URL("../contract/build/contract.wasm", import.meta.url));

function explorer(hash: string | undefined): string {
  return hash ? `https://testnet.nearblocks.io/txns/${hash}` : "(no hash returned)";
}

function txHashOf(result: unknown): string | undefined {
  return (result as { transaction?: { hash?: string } }).transaction?.hash;
}

function resolvePolicyPath(): string {
  const argIdx = process.argv.indexOf("--policy");
  if (argIdx >= 0 && process.argv[argIdx + 1]) return process.argv[argIdx + 1];
  if (existsSync("policy.json")) return "policy.json";
  return "policy.example.json";
}

async function main(): Promise<void> {
  setupProxyFromEnv();
  const config = loadConfig(); // clean failure when .env absent — before anything else

  if (!existsSync(WASM_PATH)) {
    throw new Error(
      `Guard contract WASM not found at ${WASM_PATH}. Build it first: cd contract && npm install && npm run build.`,
    );
  }
  const wasm = readFileSync(WASM_PATH);

  const policy = loadPolicy(resolvePolicyPath());
  const perCallCapYocto = policy.perTxCapYocto;
  const fundYocto = parseNearToYocto((process.env.NEAR_GUARD_FUND_NEAR ?? "").trim() || "2");
  const allowanceYocto = parseNearToYocto(
    (process.env.NEAR_SCOPED_KEY_ALLOWANCE_NEAR ?? "").trim() || "1",
  );

  const fullSigner = KeyPairSigner.fromSecretKey(config.privateKey as `ed25519:${string}`);
  const agentAccount = new Account(config.accountId, config.rpcUrl, fullSigner);

  // ---- Guard account identity ----
  const guardKeyPair = KeyPairEd25519.fromRandom();
  const guardPublicKey = guardKeyPair.getPublicKey().toString();
  const agentIsNamed = !IMPLICIT_ACCOUNT_RE.test(config.accountId);
  const envGuardId = (process.env.NEAR_GUARD_CONTRACT_ID ?? "").trim();
  let guardId: string;
  if (envGuardId) {
    if (!agentIsNamed || !envGuardId.endsWith(`.${config.accountId}`)) {
      throw new Error(
        `NEAR_GUARD_CONTRACT_ID="${envGuardId}" cannot be created by ${config.accountId}: ` +
          "the deploy can only create a subaccount of the agent account (e.g. guard.<agent>). " +
          "Unset it to use the default.",
      );
    }
    guardId = envGuardId;
  } else if (agentIsNamed) {
    guardId = `guard.${config.accountId}`;
  } else {
    // Implicit agent account: the guard account is a fresh implicit account
    // (id = hex of its public key), created by the funding transfer below.
    guardId = Buffer.from(guardKeyPair.getPublicKey().data).toString("hex");
  }

  console.log("SpendGuard guard deploy — testnet");
  console.log(`  Agent account:   ${config.accountId}`);
  console.log(`  Guard contract:  ${guardId}`);
  console.log(`  Funding:         ${process.env.NEAR_GUARD_FUND_NEAR ?? "2"} NEAR (default 2)`);
  console.log(`  On-chain per-call cap (from policy perTxCap): ${perCallCapYocto} yoctoNEAR`);
  console.log("");

  // ---- Step 1: create + fund the guard account ----
  if (agentIsNamed) {
    const res = await agentAccount.createSubAccount({
      accountOrPrefix: guardId,
      publicKey: guardPublicKey,
      nearToTransfer: fundYocto,
    });
    console.log(`1. Guard account created — tx: ${explorer(txHashOf(res))}`);
  } else {
    const res = await agentAccount.transfer({ receiverId: guardId, amount: fundYocto });
    console.log(`1. Guard account funded (implicit account created) — tx: ${explorer(txHashOf(res))}`);
  }

  const guardSigner = new KeyPairSigner(guardKeyPair);
  const guardAccount = new Account(guardId, config.rpcUrl, guardSigner);

  // ---- Step 2: deploy the contract code ----
  const deployRes = await guardAccount.deployContract(new Uint8Array(wasm));
  console.log(`2. Contract deployed — tx: ${explorer(txHashOf(deployRes))}`);

  // ---- Step 3: initialise (agent account + per-call cap) ----
  const initRes = await guardAccount.callFunctionRaw({
    contractId: guardId,
    methodName: "init",
    args: { agentAccountId: config.accountId, perCallCap: perCallCapYocto.toString() },
    gas: 30_000_000_000_000n,
  });
  console.log(`3. init(agent, cap) called — tx: ${explorer(txHashOf(initRes))}`);

  // ---- Step 4: read the config back and verify ----
  const onChain = await guardAccount.callFunction<{ agentAccountId: string; perCallCap: string }>({
    contractId: guardId,
    methodName: "getConfig",
    args: {},
  });
  console.log(`4. getConfig on-chain: ${JSON.stringify(onChain)}`);
  if (
    !onChain ||
    onChain.agentAccountId !== config.accountId ||
    onChain.perCallCap !== perCallCapYocto.toString()
  ) {
    throw new Error("getConfig does not match the intended init values — stop and investigate before continuing.");
  }
  console.log("   Verified: stored agent + cap match the deploy inputs.");

  // ---- Step 5: the agent's scoped function-call key (release only) ----
  const scopedKeyPair = KeyPairEd25519.fromRandom();
  const scopedPublicKey = scopedKeyPair.getPublicKey().toString();
  const keyRes = await agentAccount.addFunctionCallAccessKey({
    publicKey: scopedPublicKey,
    contractId: guardId,
    methodNames: ["release"],
    allowance: allowanceYocto,
  });
  console.log(`5. Scoped key created (release only, allowance ${allowanceYocto} yocto) — tx: ${explorer(txHashOf(keyRes))}`);
  const view = await agentAccount.getAccessKey(scopedPublicKey);
  console.log(`   On-chain permission: ${JSON.stringify(view.permission)}`);

  console.log("");
  console.log("DEPLOY OK. Save these lines into .env (they are shown ONCE — the two");
  console.log("private keys are secrets; .env is gitignored and must stay that way):");
  console.log("");
  console.log(`NEAR_GUARD_CONTRACT_ID=${guardId}`);
  console.log(`NEAR_SCOPED_PRIVATE_KEY=${scopedKeyPair.toString()}`);
  console.log(`NEAR_GUARD_PRIVATE_KEY=${guardKeyPair.toString()}`);
  console.log("");
  console.log("Next: npm run demo:dry (sanity), then npm run demo (live S1–S3).");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
