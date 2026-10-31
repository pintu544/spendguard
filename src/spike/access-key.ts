/**
 * Spike step 3: function-call access key, scoped to ONE contract + ONE
 * method with an allowance (TASKS P3) — the single NEAR primitive
 * SpendGuard is built on (DESIGN.md).
 *
 * Flow (all from TypeScript, near-api-js v7):
 *   1. With the wallet's FULL-ACCESS key (from .env), add a new key whose
 *      permission is FunctionCall(contractId, methodNames, allowance).
 *   2. Read the key back and verify the on-chain permission matches.
 *   3. Build a second Account whose signer is ONLY the scoped key and make
 *      one call with it — proving the protocol, not our code, enforces scope.
 *
 * Needs credentials in .env; without them it exits immediately with a clear
 * "credentials not configured" message.
 *
 * Usage:
 *   npm run spike:access-key [-- --mint-wrap 0.1]
 *   --mint-wrap N  first wrap N NEAR into wNEAR with the full-access key so
 *                  the scoped ft_transfer has a balance to move (testnet).
 */
import {
  Account,
  KeyPairEd25519,
  KeyPairSigner,
  PublicKey,
  actions,
  type Action,
} from "near-api-js";
import { parseNearToYocto } from "../amount.js";
import { loadConfig, type SpendGuardConfig } from "../config.js";
import { setupProxyFromEnv } from "../net.js";

/** The demo scope: the wNEAR contract on testnet, its transfer method only. */
export const SPIKE_SCOPE = {
  contractId: "wrap.testnet",
  methodNames: ["ft_transfer"],
  allowanceNear: "1",
} as const;

export interface FunctionCallScope {
  contractId: string;
  methodNames: string[];
  /** Allowance in yoctoNEAR; must be positive. */
  allowance: bigint;
}

const ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/**
 * Validate + normalise a function-call scope. Pure and offline — this is
 * the exact parameter set that gets baked into the on-chain key permission,
 * so every rejection here is a scope that can never reach the chain wrong.
 */
export function buildFunctionCallScope(input: {
  contractId: string;
  methodNames: readonly string[];
  allowanceNear: string;
}): FunctionCallScope {
  const contractId = input.contractId.trim();
  if (!ACCOUNT_ID_RE.test(contractId)) {
    throw new Error(`Invalid contractId "${input.contractId}" — not a NEAR account id.`);
  }
  const methodNames = [...input.methodNames];
  if (methodNames.length === 0 || methodNames.some((m) => !m.trim())) {
    throw new Error("methodNames must contain at least one non-empty method name.");
  }
  const allowance = parseNearToYocto(input.allowanceNear);
  if (allowance <= 0n) {
    throw new Error(`Allowance must be positive; "${input.allowanceNear}" NEAR is not.`);
  }
  return { contractId, methodNames, allowance };
}

/**
 * Build the (unsigned) addKey action for a scope — same action the
 * Account.addFunctionCallAccessKey helper submits. Exposed so tests can
 * verify the scoping parameters offline, with no account and no chain.
 */
export function buildScopedKeyAction(publicKey: string, scope: FunctionCallScope): Action {
  return actions.addFunctionCallAccessKey(
    PublicKey.fromString(publicKey),
    scope.contractId,
    scope.methodNames,
    scope.allowance,
  );
}

async function main(): Promise<void> {
  setupProxyFromEnv();
  const config: SpendGuardConfig = loadConfig(); // clean failure when .env absent
  const scope = buildFunctionCallScope(SPIKE_SCOPE);

  const fullSigner = KeyPairSigner.fromSecretKey(config.privateKey as `ed25519:${string}`);
  const account = new Account(config.accountId, config.rpcUrl, fullSigner);

  const mintWrapIdx = process.argv.indexOf("--mint-wrap");
  if (mintWrapIdx >= 0) {
    const wrapAmount = process.argv[mintWrapIdx + 1] ?? "0.1";
    console.log(`Wrapping ${wrapAmount} NEAR into wNEAR (full-access key, testnet)…`);
    await account.callFunctionRaw({
      contractId: scope.contractId,
      methodName: "near_deposit",
      args: {},
      deposit: parseNearToYocto(wrapAmount),
      gas: 30_000_000_000_000n,
    });
    console.log("Wrapped.");
  }

  // 1. Create the scoped key.
  const scopedKeyPair = KeyPairEd25519.fromRandom();
  const scopedPublicKey = scopedKeyPair.getPublicKey().toString();
  console.log(`Adding function-call access key ${scopedPublicKey}`);
  console.log(
    `  scope: contract=${scope.contractId} methods=[${scope.methodNames.join(", ")}] allowance=${scope.allowance} yoctoNEAR`,
  );
  await account.addFunctionCallAccessKey({
    publicKey: scopedPublicKey,
    contractId: scope.contractId,
    methodNames: scope.methodNames,
    allowance: scope.allowance,
  });

  // 2. Read it back and verify the permission on-chain.
  const view = await account.getAccessKey(scopedPublicKey);
  console.log("On-chain permission for the new key:");
  console.log(`  ${JSON.stringify(view.permission)}`);

  // 3. Make one call signed by ONLY the scoped key: move 1 unit of wNEAR
  //    to the account itself (ft_transfer requires exactly 1 yocto attached).
  const scopedAccount = new Account(
    config.accountId,
    config.rpcUrl,
    new KeyPairSigner(scopedKeyPair),
  );
  console.log("Calling ft_transfer with the scoped key only…");
  const result = await scopedAccount.callFunctionRaw({
    contractId: scope.contractId,
    methodName: "ft_transfer",
    args: { receiver_id: config.accountId, amount: "1", memo: "spendguard spike P3" },
    deposit: 1n,
    gas: 30_000_000_000_000n,
  });
  const hash = (result as { transaction?: { hash?: string } }).transaction?.hash;
  console.log("SCOPED CALL EXECUTED");
  if (hash) console.log(`Tx hash:  ${hash}\nExplorer: https://testnet.nearblocks.io/txns/${hash}`);
  console.log(
    "Note: the scoped key's secret was generated in-memory for this spike run and not stored. For the build, generate it once and keep it in the agent's env (never in the repo).",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
