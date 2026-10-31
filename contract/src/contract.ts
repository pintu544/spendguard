/**
 * SpendGuard guard contract (near-sdk-js) — the on-chain enforcement layer.
 *
 * Holds a small NEAR balance on its own account and pays out of that
 * balance through ONE non-payable method, `release`. Non-payable is the
 * whole point: NEAR forbids attaching a deposit to a call signed by a
 * function-call access key (`DepositWithFunctionCall`), so the agent's
 * scoped key can sign `release` — and nothing that moves its own funds.
 * All authorisation/cap logic lives in `./validation` as pure functions;
 * this class only wires in chain state and performs the transfer.
 */
import { NearBindgen, NearPromise, call, initialize, near, view } from "near-sdk-js";
import { assertReleaseAllowed, validateInitConfig } from "./validation";

@NearBindgen({ requireInit: true })
class SpendGuard {
  /** The one account authorised to call `release` (the agent's account). */
  agentAccountId: string;
  /** Per-call cap in yoctoNEAR, stored as a decimal string (see validation.ts). */
  perCallCap: string;

  constructor() {
    this.agentAccountId = "";
    this.perCallCap = "0";
  }

  /**
   * One-time initialisation (deploy runbook calls this once, from the
   * contract account's full-access key). `perCallCap` is a yoctoNEAR
   * decimal string, e.g. "1000000000000000000000000" for 1 NEAR.
   */
  @initialize({})
  init({ agentAccountId, perCallCap }: { agentAccountId: string; perCallCap: string }) {
    const config = validateInitConfig({ agentAccountId, perCallCap });
    this.agentAccountId = config.agentAccountId;
    this.perCallCap = config.perCallCap;
  }

  /**
   * Release `amount` yoctoNEAR (decimal string) from the contract's own
   * balance to `to`. Deliberately NOT payable: `@call({})` leaves
   * `payableFunction` at its default false, so the SDK panics if any
   * deposit is attached — a function-call access key can sign this.
   * Guards (caller, cap, balance) run in `assertReleaseAllowed` before
   * the transfer promise is created.
   */
  @call({})
  release({ to, amount }: { to: string; amount: string }) {
    const amountYocto = assertReleaseAllowed({
      predecessorAccountId: near.predecessorAccountId(),
      agentAccountId: this.agentAccountId,
      to,
      amount,
      perCallCap: this.perCallCap,
      contractBalance: near.accountBalance(),
    });
    return NearPromise.new(to).transfer(amountYocto);
  }

  /** Stored config, for the demo and debugging: who may call, and the cap. */
  @view({})
  getConfig() {
    return { agentAccountId: this.agentAccountId, perCallCap: this.perCallCap };
  }
}
