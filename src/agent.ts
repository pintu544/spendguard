import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatYoctoAsNear, parseNearToYocto } from "./amount.js";
import { loadExecutorConfig } from "./config.js";
import { evaluateProposal, type Verdict } from "./engine.js";
import { TemplateExplainer } from "./explainer.js";
import { Executor, createLiveExecutor } from "./executor.js";
import {
  appendVerdictLog,
  readVerdictLog,
  spentTodayYocto,
  withLock,
  type VerdictLogEntry,
} from "./log.js";
import { setupProxyFromEnv } from "./net.js";
import { loadPolicy, type Policy } from "./policy.js";

/**
 * The scripted demo agent (DESIGN.md component 3): a deliberately simple
 * stand-in for an autonomous agent. It proposes three payments in sequence —
 * the product on trial is the guard, not the agent:
 *
 *   S1  inside policy            → ALLOW, executes (or dry-run)
 *   S2  over the per-tx cap      → DENY (R2), nothing signed
 *   S3  non-allowlisted recipient → DENY (R1), nothing signed
 *
 * Scenario amounts are derived from the loaded policy, so the demo behaves
 * the same whatever caps the human configured. Every verdict is explained
 * in one sentence and appended to the verdict log.
 *
 * Usage:
 *   npm run demo        live — needs .env (agent account + scoped key)
 *   npm run demo:dry    dry run — policy only, signs nothing, no .env needed
 */

interface Scenario {
  id: string;
  title: string;
  recipient: string;
  amountYocto: bigint;
}

function buildScenarios(policy: Policy): Scenario[] {
  // S1: half the large-payment threshold — inside every rule for a fresh day.
  const s1Amount = policy.largePaymentThresholdYocto / 2n > 0n
    ? policy.largePaymentThresholdYocto / 2n
    : 1n;
  // S2: per-tx cap + 0.1 NEAR — over the cap whatever the cap is.
  const s2Amount = policy.perTxCapYocto + parseNearToYocto("0.1");
  // S3: a plausible vendor id that is (checked) not on the allowlist.
  const s3Recipient =
    ["unlisted-vendor.testnet", "mallory.testnet", "stranger.testnet"].find(
      (candidate) => !policy.allowlist.includes(candidate),
    ) ?? "not-on-the-allowlist.testnet";
  return [
    { id: "S1", title: "payment inside policy", recipient: policy.allowlist[0], amountYocto: s1Amount },
    { id: "S2", title: "payment over the per-transaction cap", recipient: policy.allowlist[0], amountYocto: s2Amount },
    { id: "S3", title: "payment to a non-allowlisted recipient", recipient: s3Recipient, amountYocto: s1Amount },
  ];
}

function resolvePolicyPath(): string {
  const argIdx = process.argv.indexOf("--policy");
  if (argIdx >= 0 && process.argv[argIdx + 1]) return resolve(process.argv[argIdx + 1]);
  const envPath = (process.env.SPENDGUARD_POLICY ?? "").trim();
  if (envPath) return resolve(envPath);
  const policyJson = resolve(process.cwd(), "policy.json");
  return existsSync(policyJson) ? policyJson : resolve(process.cwd(), "policy.example.json");
}

async function main(): Promise<void> {
  setupProxyFromEnv();
  const dryRun = process.argv.includes("--dry-run");

  const policyPath = resolvePolicyPath();
  const policy = loadPolicy(policyPath); // refuses to start on an invalid policy
  console.log(`SpendGuard demo — policy: ${policyPath}`);
  console.log(
    `Caps: per-tx ${formatYoctoAsNear(policy.perTxCapYocto)} NEAR · daily ${formatYoctoAsNear(policy.dailyCapYocto)} NEAR · escalate above ${formatYoctoAsNear(policy.largePaymentThresholdYocto)} NEAR`,
  );
  console.log(`Allowlist: ${policy.allowlist.join(", ")}`);

  let executor: Executor;
  if (dryRun) {
    console.log("Mode: DRY RUN — verdicts are evaluated and logged; nothing is signed.\n");
    executor = new Executor({ dryRun: true });
  } else {
    const config = loadExecutorConfig(); // clean failure when .env is absent/incomplete
    console.log(`Mode: LIVE (testnet) — agent account ${config.accountId}, guard contract ${config.guardContractId}\n`);
    executor = createLiveExecutor(config);
  }

  const logPath =
    (process.env.SPENDGUARD_LOG_PATH ?? "").trim() || resolve(process.cwd(), "logs/verdicts.jsonl");
  const explainer = new TemplateExplainer();

  for (const scenario of buildScenarios(policy)) {
    const amountNear = formatYoctoAsNear(scenario.amountYocto);
    console.log(`[${scenario.id}] ${scenario.title}`);
    console.log(`  Agent proposes: pay ${amountNear} NEAR to ${scenario.recipient}`);

    // Lock the read-evaluate-execute-append cycle so concurrent agents cannot
    // both read spentToday = 0 and both decide to execute within the daily cap.
    await withLock(`${logPath}.lock`, async () => {
      const freshEntries = readVerdictLog(logPath);
      const spent = spentTodayYocto(freshEntries, new Date());
      const verdict: Verdict = evaluateProposal(
        policy,
        { recipient: scenario.recipient, amountNear },
        spent,
      );
      const explanation = explainer.explain(verdict);
      console.log(`  Verdict: ${verdict.decision} (rule ${verdict.ruleId})`);
      console.log(`  ${explanation}`);

      let executed = false;
      let txHash: string | undefined;
      let explorerUrl: string | undefined;
      if (verdict.decision === "ALLOW") {
        const outcome = await executor.execute(verdict, {
          recipient: scenario.recipient,
          amountYocto: scenario.amountYocto,
        });
        if (outcome.status === "executed") {
          executed = true;
          txHash = outcome.txHash;
          explorerUrl = outcome.explorerUrl;
          console.log(`  Executed on testnet — tx hash: ${txHash}`);
          console.log(`  Explorer: ${explorerUrl}`);
        } else {
          console.log("  Dry run — this payment would execute live; nothing was signed.");
        }
      } else {
        console.log("  Nothing signed.");
      }

      const entry: VerdictLogEntry = {
        ts: new Date().toISOString(),
        scenario: scenario.id,
        proposal: {
          recipient: scenario.recipient,
          amountNear,
          amountYocto: scenario.amountYocto.toString(),
        },
        decision: verdict.decision,
        ruleId: verdict.ruleId,
        reason: verdict.reason,
        explanation,
        executed,
        dryRun,
        ...(txHash ? { txHash } : {}),
        ...(explorerUrl ? { explorerUrl } : {}),
      };
      appendVerdictLog(logPath, entry);
    });
    console.log("");
  }

  console.log(`Verdict log: ${logPath}`);
  console.log("Daily report: npm run report");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
