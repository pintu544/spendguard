import { formatYoctoAsNear, parseNearToYocto } from "./amount.js";
import type { Policy } from "./policy.js";

/**
 * SpendGuard's deterministic verdict engine (DESIGN.md component 1).
 *
 * Pure functions only — no I/O, no clock, no randomness: the same policy +
 * proposal + spent-today total always yields the same verdict. Rules are
 * evaluated in order, first hit wins:
 *
 *   R0 proposal malformed            → DENY     (never guessed)
 *   R1 recipient not in allowlist    → DENY
 *   R2 amount > per-transaction cap  → DENY
 *   R3 amount + spent today > daily cap → DENY
 *   R4 amount > large-payment threshold → ESCALATE (human approves; never auto-signed)
 *   otherwise                        → ALLOW
 *
 * Every verdict carries the rule id and the exact numbers the rule used, so
 * the verdict log is a complete audit trail.
 */

export type Decision = "ALLOW" | "DENY" | "ESCALATE";

export type RuleId =
  | "R0_MALFORMED"
  | "R1_ALLOWLIST"
  | "R2_PER_TX_CAP"
  | "R3_DAILY_CAP"
  | "R4_LARGE_PAYMENT"
  | "PASS";

/** A payment as proposed by an agent. Fields are unknown until R0 validates them. */
export interface PaymentProposalInput {
  recipient?: unknown;
  /** Human NEAR decimal string, e.g. "0.25". */
  amountNear?: unknown;
}

export interface VerdictDetails {
  recipient: string | null;
  amountYocto: string | null;
  perTxCapYocto: string;
  dailyCapYocto: string;
  largePaymentThresholdYocto: string;
  spentTodayYocto: string;
  /** amount + spentToday, when the amount parsed. */
  projectedTodayYocto: string | null;
}

export interface Verdict {
  decision: Decision;
  ruleId: RuleId;
  /** Deterministic, human-readable statement of why — safe to log and show. */
  reason: string;
  details: VerdictDetails;
}

function baseDetails(
  policy: Policy,
  spentTodayYocto: bigint,
  recipient: string | null,
  amountYocto: bigint | null,
): VerdictDetails {
  return {
    recipient,
    amountYocto: amountYocto === null ? null : amountYocto.toString(),
    perTxCapYocto: policy.perTxCapYocto.toString(),
    dailyCapYocto: policy.dailyCapYocto.toString(),
    largePaymentThresholdYocto: policy.largePaymentThresholdYocto.toString(),
    spentTodayYocto: spentTodayYocto.toString(),
    projectedTodayYocto:
      amountYocto === null ? null : (amountYocto + spentTodayYocto).toString(),
  };
}

export function evaluateProposal(
  policy: Policy,
  proposal: PaymentProposalInput | null | undefined,
  spentTodayYocto: bigint,
): Verdict {
  // ---- R0: malformed proposals are denied, never guessed. ----
  if (typeof proposal !== "object" || proposal === null) {
    return {
      decision: "DENY",
      ruleId: "R0_MALFORMED",
      reason: "Proposal is not an object with recipient and amountNear fields.",
      details: baseDetails(policy, spentTodayYocto, null, null),
    };
  }
  const recipient =
    typeof proposal.recipient === "string" ? proposal.recipient.trim() : "";
  if (!recipient) {
    return {
      decision: "DENY",
      ruleId: "R0_MALFORMED",
      reason: "Proposal has no recipient (missing, empty, or not a string).",
      details: baseDetails(policy, spentTodayYocto, null, null),
    };
  }
  let amountYocto: bigint | null = null;
  if (typeof proposal.amountNear === "string") {
    try {
      amountYocto = parseNearToYocto(proposal.amountNear);
    } catch {
      amountYocto = null;
    }
  }
  if (amountYocto === null || amountYocto <= 0n) {
    return {
      decision: "DENY",
      ruleId: "R0_MALFORMED",
      reason: `Proposal amount ${JSON.stringify(proposal.amountNear)} is not a positive NEAR amount.`,
      details: baseDetails(policy, spentTodayYocto, recipient, null),
    };
  }

  const details = baseDetails(policy, spentTodayYocto, recipient, amountYocto);
  const amountNear = formatYoctoAsNear(amountYocto);

  // ---- R1: allowlist. ----
  if (!policy.allowlist.includes(recipient)) {
    return {
      decision: "DENY",
      ruleId: "R1_ALLOWLIST",
      reason: `Recipient ${recipient} is not in the policy allowlist.`,
      details,
    };
  }

  // ---- R2: per-transaction cap (exactly at the cap passes). ----
  if (amountYocto > policy.perTxCapYocto) {
    return {
      decision: "DENY",
      ruleId: "R2_PER_TX_CAP",
      reason: `Amount ${amountNear} NEAR exceeds the per-transaction cap of ${formatYoctoAsNear(policy.perTxCapYocto)} NEAR.`,
      details,
    };
  }

  // ---- R3: daily cap (exactly reaching the cap passes). ----
  if (amountYocto + spentTodayYocto > policy.dailyCapYocto) {
    return {
      decision: "DENY",
      ruleId: "R3_DAILY_CAP",
      reason: `Amount ${amountNear} NEAR plus ${formatYoctoAsNear(spentTodayYocto)} NEAR already spent today exceeds the daily cap of ${formatYoctoAsNear(policy.dailyCapYocto)} NEAR.`,
      details,
    };
  }

  // ---- R4: large-payment band — a human decides, nothing is auto-signed. ----
  if (amountYocto > policy.largePaymentThresholdYocto) {
    return {
      decision: "ESCALATE",
      ruleId: "R4_LARGE_PAYMENT",
      reason: `Amount ${amountNear} NEAR is above the large-payment threshold of ${formatYoctoAsNear(policy.largePaymentThresholdYocto)} NEAR; held for human approval.`,
      details,
    };
  }

  return {
    decision: "ALLOW",
    ruleId: "PASS",
    reason: `Amount ${amountNear} NEAR to ${recipient} is within the allowlist, per-transaction cap, daily cap, and large-payment threshold.`,
    details,
  };
}
