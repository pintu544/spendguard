import { Account, KeyPairSigner } from "near-api-js";
import type { ExecutorConfig } from "./config.js";
import type { Verdict } from "./engine.js";

/**
 * The executor (DESIGN.md component 2): the only component that can move
 * money, and the most constrained one.
 *
 * - It receives a finished verdict and executes ONLY `ALLOW` verdicts —
 *   anything else is refused with an error before any network call exists.
 * - Execution is a single call to the guard contract's `release(to, amount)`,
 *   signed with the agent's function-call access key, with NO deposit
 *   attached (the only call shape such a key may sign — Gate 1).
 * - In `dryRun` mode it evaluates + reports without signing anything, so the
 *   demo and judges can run the whole pipeline with no credentials at all.
 *
 * The chain call sits behind the small `ReleasePort` interface so the
 * refusal logic is unit-testable offline with a stub port.
 */

/** Gas for one release() call — generous for a transfer, far under the block limit. */
export const RELEASE_GAS = 30_000_000_000_000n;

export class ExecutorRefusedError extends Error {
  readonly verdict: Verdict;
  constructor(verdict: Verdict) {
    super(
      `Executor refused a ${verdict.decision} verdict (${verdict.ruleId}): only ALLOW verdicts execute. Nothing was signed.`,
    );
    this.name = "ExecutorRefusedError";
    this.verdict = verdict;
  }
}

/** The minimal chain surface the executor needs — stubbed in tests. */
export interface ReleasePort {
  release(args: {
    contractId: string;
    to: string;
    amountYocto: bigint;
  }): Promise<{ txHash: string }>;
}

/** The real port: near-api-js, signer = the scoped function-call key only. */
export class NearReleasePort implements ReleasePort {
  private readonly account: Account;

  constructor(config: ExecutorConfig) {
    const signer = KeyPairSigner.fromSecretKey(
      config.scopedPrivateKey as `ed25519:${string}`,
    );
    this.account = new Account(config.accountId, config.rpcUrl, signer);
  }

  async release(args: {
    contractId: string;
    to: string;
    amountYocto: bigint;
  }): Promise<{ txHash: string }> {
    const result = await this.account.callFunctionRaw({
      contractId: args.contractId,
      methodName: "release",
      args: { to: args.to, amount: args.amountYocto.toString() },
      // No deposit — deliberately. A function-call access key may not attach
      // one (DepositWithFunctionCall); release() spends the contract's own
      // balance, so none is needed.
      gas: RELEASE_GAS,
    });
    const hash = (result as { transaction?: { hash?: string } }).transaction?.hash;
    if (!hash) throw new Error("release() returned no transaction hash — treating as not executed.");
    return { txHash: hash };
  }
}

export interface ExecutionOutcome {
  status: "executed" | "dry-run";
  txHash?: string;
  explorerUrl?: string;
}

export function explorerUrlFor(txHash: string): string {
  return `https://testnet.nearblocks.io/txns/${txHash}`;
}

export class Executor {
  private readonly guardContractId?: string;
  private readonly port?: ReleasePort;
  private readonly dryRun: boolean;

  constructor(opts: { guardContractId?: string; port?: ReleasePort; dryRun?: boolean }) {
    this.dryRun = opts.dryRun ?? false;
    if (!this.dryRun && (!opts.port || !opts.guardContractId)) {
      throw new Error("Executor: a ReleasePort and guardContractId are required unless dryRun is set.");
    }
    this.guardContractId = opts.guardContractId;
    this.port = opts.port;
  }

  /**
   * Execute an ALLOW verdict. Throws ExecutorRefusedError for DENY/ESCALATE
   * (before any chain call), and a plain Error if the payment handed in does
   * not match the payment the verdict was computed for.
   */
  async execute(
    verdict: Verdict,
    payment: { recipient: string; amountYocto: bigint },
  ): Promise<ExecutionOutcome> {
    if (verdict.decision !== "ALLOW") {
      throw new ExecutorRefusedError(verdict);
    }
    if (
      verdict.details.recipient !== payment.recipient ||
      verdict.details.amountYocto === null ||
      BigInt(verdict.details.amountYocto) !== payment.amountYocto
    ) {
      throw new Error(
        "Executor: the payment does not match the evaluated verdict — refusing to sign anything.",
      );
    }
    if (this.dryRun) {
      return { status: "dry-run" };
    }
    const { txHash } = await this.port!.release({
      contractId: this.guardContractId!,
      to: payment.recipient,
      amountYocto: payment.amountYocto,
    });
    return { status: "executed", txHash, explorerUrl: explorerUrlFor(txHash) };
  }
}

/** Build the live executor from validated executor config. */
export function createLiveExecutor(config: ExecutorConfig): Executor {
  return new Executor({
    guardContractId: config.guardContractId,
    port: new NearReleasePort(config),
  });
}
