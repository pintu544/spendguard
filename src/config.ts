import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Credential + network configuration for the SpendGuard spike.
 *
 * Credentials come ONLY from environment variables (or a local `.env` file
 * loaded from the project root). Nothing is ever read from the repo itself,
 * and no real key material belongs anywhere but a gitignored `.env` (600).
 */

export const RPC_URLS: Record<string, string> = {
  testnet: "https://rpc.testnet.near.org",
  mainnet: "https://rpc.mainnet.near.org",
};

export class CredentialsNotConfiguredError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(
      [
        "SpendGuard credentials not configured.",
        `Missing: ${missing.join(", ")}`,
        "Fix: copy .env.example to .env, fill in your TESTNET account id and",
        "full-access private key (ed25519:...), then chmod 600 .env.",
        "See spec/SPIKE.md for the account-creation steps.",
      ].join("\n"),
    );
    this.name = "CredentialsNotConfiguredError";
    this.missing = missing;
  }
}

export interface SpendGuardConfig {
  accountId: string;
  /** Full-access private key string, `ed25519:...` form. Never log this. */
  privateKey: string;
  network: string;
  rpcUrl: string;
}

/** Load `.env` from the project root into process.env if it exists. */
export function loadDotEnv(envPath: string = resolve(process.cwd(), ".env")): boolean {
  if (!existsSync(envPath)) return false;
  // Node >= 20.12 built-in; no dotenv dependency needed.
  process.loadEnvFile(envPath);
  return true;
}

/**
 * Parse and validate spike configuration from an environment map.
 * Pure and offline-testable: pass any env object, get config or a
 * CredentialsNotConfiguredError / Error with a precise message.
 */
export function parseConfig(env: NodeJS.ProcessEnv): SpendGuardConfig {
  const missing: string[] = [];
  const accountId = (env.NEAR_ACCOUNT_ID ?? "").trim();
  const privateKey = (env.NEAR_PRIVATE_KEY ?? "").trim();
  if (!accountId) missing.push("NEAR_ACCOUNT_ID");
  if (!privateKey) missing.push("NEAR_PRIVATE_KEY");
  if (missing.length > 0) throw new CredentialsNotConfiguredError(missing);

  if (!privateKey.startsWith("ed25519:")) {
    throw new Error(
      "NEAR_PRIVATE_KEY must be in ed25519:... form (the format NEAR wallets export). Refusing to continue.",
    );
  }

  const network = (env.NEAR_NETWORK ?? "testnet").trim() || "testnet";
  if (network !== "testnet") {
    // Hard guard for this project: SPEC.md scope is testnet only, no mainnet anything.
    throw new Error(
      `NEAR_NETWORK is "${network}". SpendGuard is testnet-only by design; set NEAR_NETWORK=testnet.`,
    );
  }

  const rpcUrl = (env.NEAR_RPC_URL ?? "").trim() || RPC_URLS[network];
  return { accountId, privateKey, network, rpcUrl };
}

/** Load `.env` (if present) and return validated config, failing cleanly otherwise. */
export function loadConfig(): SpendGuardConfig {
  loadDotEnv();
  return parseConfig(process.env);
}
