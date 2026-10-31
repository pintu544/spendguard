/**
 * SpendGuard guard contract — pure authorisation & validation logic.
 *
 * Deliberately free of any near-sdk-js imports: every guard the on-chain
 * `release` method enforces lives here as a pure function of plain inputs,
 * so the rules are unit-testable offline (repo-root `test/` suite) and the
 * contract class in `contract.ts` is only a thin wrapper that feeds in
 * chain state (predecessor account, contract balance) and performs the
 * transfer.
 *
 * All amounts are yoctoNEAR carried as decimal strings (JSON cannot carry
 * a u128 safely) and parsed to bigint here — never via Number.
 */

export interface GuardConfig {
  /** The one account authorised to call `release` (the agent's account). */
  agentAccountId: string;
  /** Per-call cap in yoctoNEAR, decimal string (the form stored on-chain). */
  perCallCap: string;
}

export interface ReleaseRequest {
  /** `near.predecessorAccountId()` — the account that signed the call. */
  predecessorAccountId: string;
  /** The authorised agent account id stored at init. */
  agentAccountId: string;
  /** Recipient of the released funds. */
  to: string;
  /** Amount to release, yoctoNEAR decimal string (the `amount` argument). */
  amount: string;
  /** Stored per-call cap, yoctoNEAR decimal string. */
  perCallCap: string;
  /** `near.accountBalance()` of the contract account, in yoctoNEAR. */
  contractBalance: bigint;
}

/**
 * Named account ids: dot-separated labels of lowercase letters/digits with
 * `-`/`_` separators inside a label (same shape the spike validated for
 * contract ids). Implicit accounts are 64 lowercase hex characters.
 */
const NAMED_ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT_ACCOUNT_RE = /^[0-9a-f]{64}$/;

export function isValidAccountId(accountId: string): boolean {
  if (typeof accountId !== "string" || accountId.length < 2 || accountId.length > 64) {
    return false;
  }
  return NAMED_ACCOUNT_RE.test(accountId) || IMPLICIT_ACCOUNT_RE.test(accountId);
}

/**
 * Parse a yoctoNEAR decimal string to bigint, strictly: digits only.
 * Rejects empty strings, signs, decimal points, exponents and whitespace —
 * a silently misparsed amount is exactly the failure this code exists to
 * prevent.
 */
export function parseYocto(value: string, field: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error(
      `${field} must be a non-negative integer amount in yoctoNEAR (decimal string), got ${JSON.stringify(value)}`,
    );
  }
  return BigInt(value);
}

/**
 * Validate the `init` arguments and return the normalised config to store.
 * The cap is stored as its canonical decimal string (leading zeros removed)
 * and re-parsed to bigint at every use — near-sdk-js state serialisation
 * round-trips bigints as strings, so the string IS the safe storage form.
 */
export function validateInitConfig(input: {
  agentAccountId: string;
  perCallCap: string;
}): GuardConfig {
  const agentAccountId =
    typeof input.agentAccountId === "string" ? input.agentAccountId.trim() : "";
  if (!isValidAccountId(agentAccountId)) {
    throw new Error(
      `Invalid agentAccountId ${JSON.stringify(input.agentAccountId)} — not a NEAR account id.`,
    );
  }
  const cap = parseYocto(input.perCallCap, "perCallCap");
  if (cap <= 0n) {
    throw new Error(`perCallCap must be positive; "${input.perCallCap}" is not.`);
  }
  return { agentAccountId, perCallCap: cap.toString() };
}

/**
 * The `release` guards, in order. Returns the parsed amount (yoctoNEAR) on
 * success; throws with the reason on the first failed guard.
 *
 * Input well-formedness (amounts parse as yocto integers, recipient is a
 * real account-id shape) is checked first — a malformed call is not a
 * policy decision. Then, in order:
 *   1. caller: predecessor must be the authorised agent account;
 *   2. amount: must be > 0 and <= the per-call cap;
 *   3. balance: must be <= what the contract account actually holds.
 */
export function assertReleaseAllowed(request: ReleaseRequest): bigint {
  const amount = parseYocto(request.amount, "amount");
  const cap = parseYocto(request.perCallCap, "perCallCap");
  if (!isValidAccountId(request.to)) {
    throw new Error(
      `Invalid recipient ${JSON.stringify(request.to)} — "to" is not a NEAR account id.`,
    );
  }

  // Guard 1 — authorisation: only the agent account may release funds.
  if (request.predecessorAccountId !== request.agentAccountId) {
    throw new Error(
      `release is restricted to the authorised agent account (${request.agentAccountId}); caller was ${request.predecessorAccountId}.`,
    );
  }

  // Guard 2 — amount: positive and within the per-call cap.
  if (amount <= 0n) {
    throw new Error(`amount must be positive; got ${amount} yoctoNEAR.`);
  }
  if (amount > cap) {
    throw new Error(
      `amount ${amount} yoctoNEAR exceeds the per-call cap of ${cap} yoctoNEAR.`,
    );
  }

  // Guard 3 — balance: the contract cannot pay out more than it holds.
  if (amount > request.contractBalance) {
    throw new Error(
      `amount ${amount} yoctoNEAR exceeds the contract balance of ${request.contractBalance} yoctoNEAR.`,
    );
  }

  return amount;
}
