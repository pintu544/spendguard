import { describe, expect, it } from "vitest";
import { evaluateProposal } from "../src/engine.js";
import { TemplateExplainer, explainVerdict } from "../src/explainer.js";
import { parsePolicy, type Policy } from "../src/policy.js";

const NEAR = 10n ** 24n;
const policy: Policy = parsePolicy({
  perTxCap: "1",
  dailyCap: "2",
  largePaymentThreshold: "0.5",
  allowlist: ["api-vendor.testnet"],
});
const explainer = new TemplateExplainer();

describe("TemplateExplainer", () => {
  it("explains an ALLOW with the caps and today's spend", () => {
    const v = evaluateProposal(policy, { recipient: "api-vendor.testnet", amountNear: "0.25" }, NEAR / 2n);
    const s = explainer.explain(v);
    expect(s).toContain("Allowed: 0.25 NEAR to api-vendor.testnet");
    expect(s).toContain("per-transaction cap of 1 NEAR");
    expect(s).toContain("0.5 NEAR already spent today");
  });

  it("explains an R3 denial the way the SPEC example reads", () => {
    const spent = (19n * NEAR) / 10n;
    const v = evaluateProposal(policy, { recipient: "api-vendor.testnet", amountNear: "0.25" }, spent);
    const s = explainer.explain(v);
    expect(s).toContain("exceeds your 2 NEAR daily cap");
    expect(s).toContain("1.9 NEAR already spent today");
  });

  it("explains R1, R2, R4 and R0 verdicts with their rule content", () => {
    const r1 = explainer.explain(evaluateProposal(policy, { recipient: "mallory.testnet", amountNear: "0.1" }, 0n));
    expect(r1).toContain("not on your allowlist");
    const r2 = explainer.explain(evaluateProposal(policy, { recipient: "api-vendor.testnet", amountNear: "5" }, 0n));
    expect(r2).toContain("exceeds your per-transaction cap of 1 NEAR");
    const r4 = explainer.explain(evaluateProposal(policy, { recipient: "api-vendor.testnet", amountNear: "0.75" }, 0n));
    expect(r4).toContain("held for your approval");
    const r0 = explainer.explain(evaluateProposal(policy, {}, 0n));
    expect(r0).toContain("malformed");
  });

  it("is deterministic: the same verdict yields the same sentence", () => {
    const v = evaluateProposal(policy, { recipient: "api-vendor.testnet", amountNear: "0.25" }, 0n);
    expect(explainVerdict(v)).toBe(explainer.explain(v));
    expect(explainer.explain(v)).toBe(explainer.explain(v));
  });
});
