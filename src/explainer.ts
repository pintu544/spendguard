import { formatYoctoAsNear } from "./amount.js";
import type { Verdict } from "./engine.js";

/**
 * The explainer (DESIGN.md component 4): turns a verdict into ONE
 * plain-English sentence for the human reading the log.
 *
 * It sits behind this interface so an LLM implementation can be dropped in
 * later — but per decision D5 (GRILL.md) no LLM key is approved for this
 * entry, so the only implementation that ships is the deterministic
 * template below. The explainer is presentation only: it reads a finished
 * verdict and can never change one.
 */
export interface Explainer {
  explain(verdict: Verdict): string;
}

export class TemplateExplainer implements Explainer {
  explain(verdict: Verdict): string {
    const d = verdict.details;
    const amount =
      d.amountYocto === null ? "an unknown amount" : `${formatYoctoAsNear(BigInt(d.amountYocto))} NEAR`;
    const recipient = d.recipient ?? "an unknown recipient";
    const perTx = formatYoctoAsNear(BigInt(d.perTxCapYocto));
    const daily = formatYoctoAsNear(BigInt(d.dailyCapYocto));
    const threshold = formatYoctoAsNear(BigInt(d.largePaymentThresholdYocto));
    const spent = formatYoctoAsNear(BigInt(d.spentTodayYocto));

    switch (verdict.ruleId) {
      case "PASS":
        return `Allowed: ${amount} to ${recipient} — within your per-transaction cap of ${perTx} NEAR and daily cap of ${daily} NEAR (${spent} NEAR already spent today).`;
      case "R1_ALLOWLIST":
        return `Denied: ${recipient} is not on your allowlist, so the payment of ${amount} was blocked before anything was signed.`;
      case "R2_PER_TX_CAP":
        return `Denied: ${amount} to ${recipient} exceeds your per-transaction cap of ${perTx} NEAR — nothing was signed.`;
      case "R3_DAILY_CAP":
        return `Denied: ${amount} to ${recipient} exceeds your ${daily} NEAR daily cap — ${spent} NEAR already spent today. Nothing was signed.`;
      case "R4_LARGE_PAYMENT":
        return `Escalated: ${amount} to ${recipient} is above your large-payment threshold of ${threshold} NEAR — held for your approval, nothing was signed.`;
      case "R0_MALFORMED":
        return `Denied: the proposal was malformed (${verdict.reason}) — nothing was signed.`;
      default:
        return `Verdict: ${verdict.decision} (rule ${verdict.ruleId}) — ${verdict.reason}`;
    }
  }
}

/** Convenience: explain with the default (template) explainer. */
export function explainVerdict(verdict: Verdict): string {
  return new TemplateExplainer().explain(verdict);
}
