import { existsSync, readFileSync } from "node:fs";
import { parseNearToYocto } from "./amount.js";

/**
 * SpendGuard policy: the human-written rules the engine enforces.
 *
 * On disk (JSON) amounts are human NEAR decimal strings ("1.5"); in memory
 * they are yoctoNEAR bigints — exact, never floats. The loader is strict on
 * purpose: a policy is a security control, so anything it cannot interpret
 * exactly is a refusal to start, with the precise field named (DESIGN.md:
 * "Policy file invalid → loader refuses to start with the exact validation
 * error").
 */

export class PolicyValidationError extends Error {
  constructor(detail: string) {
    super(`Invalid policy: ${detail}`);
    this.name = "PolicyValidationError";
  }
}

export interface Policy {
  /** R2: a single payment may not exceed this (yoctoNEAR). */
  perTxCapYocto: bigint;
  /** R3: the sum of today's ALLOWed payments may not exceed this (yoctoNEAR). */
  dailyCapYocto: bigint;
  /** R4: a payment above this (but within the caps) escalates to a human (yoctoNEAR). */
  largePaymentThresholdYocto: bigint;
  /** R1: the only recipients the agent may pay. Exact account-id strings. */
  allowlist: string[];
}

const KNOWN_FIELDS = ["perTxCap", "dailyCap", "largePaymentThreshold", "allowlist"];

// Same account-id shape the guard contract validates (named ids; implicit
// 64-hex ids also match this pattern's label rules via the hex charset).
const ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

function amountField(raw: Record<string, unknown>, field: string): bigint {
  const value = raw[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new PolicyValidationError(
      `"${field}" must be a NEAR amount string like "1.5", got ${JSON.stringify(value)}.`,
    );
  }
  let yocto: bigint;
  try {
    yocto = parseNearToYocto(value);
  } catch {
    throw new PolicyValidationError(
      `"${field}" is not a valid NEAR amount: ${JSON.stringify(value)}.`,
    );
  }
  if (yocto <= 0n) {
    throw new PolicyValidationError(`"${field}" must be positive, got "${value}".`);
  }
  return yocto;
}

/** Validate an already-parsed JSON value into a Policy. Pure; throws PolicyValidationError. */
export function parsePolicy(raw: unknown): Policy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PolicyValidationError("the policy must be a JSON object.");
  }
  const obj = raw as Record<string, unknown>;

  const unknown = Object.keys(obj).filter((k) => !KNOWN_FIELDS.includes(k));
  if (unknown.length > 0) {
    throw new PolicyValidationError(
      `unknown field(s): ${unknown.map((k) => `"${k}"`).join(", ")}. Known fields: ${KNOWN_FIELDS.join(", ")}.`,
    );
  }

  const perTxCapYocto = amountField(obj, "perTxCap");
  const dailyCapYocto = amountField(obj, "dailyCap");
  if (perTxCapYocto > dailyCapYocto) {
    throw new PolicyValidationError(
      `"perTxCap" must not exceed "dailyCap" (a per-transaction cap larger than the daily cap makes the daily cap unreachable), got perTxCap "${String(obj.perTxCap)}" vs dailyCap "${String(obj.dailyCap)}".`,
    );
  }
  const largePaymentThresholdYocto = amountField(obj, "largePaymentThreshold");
  if (largePaymentThresholdYocto >= perTxCapYocto) {
    throw new PolicyValidationError(
      `"largePaymentThreshold" must be below "perTxCap" (it is the escalate band inside the cap), got threshold "${String(obj.largePaymentThreshold)}" vs perTxCap "${String(obj.perTxCap)}".`,
    );
  }

  const rawList = obj.allowlist;
  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw new PolicyValidationError(`"allowlist" must be a non-empty array of NEAR account ids.`);
  }
  const allowlist: string[] = [];
  for (const entry of rawList) {
    if (typeof entry !== "string" || !ACCOUNT_ID_RE.test(entry)) {
      throw new PolicyValidationError(
        `"allowlist" entry ${JSON.stringify(entry)} is not a NEAR account id.`,
      );
    }
    if (entry.length < 2 || entry.length > 64) {
      throw new PolicyValidationError(
        `"allowlist" entry ${JSON.stringify(entry)} has length ${entry.length}; NEAR account ids must be 2–64 characters.`,
      );
    }
    if (allowlist.includes(entry)) {
      throw new PolicyValidationError(`"allowlist" contains "${entry}" twice.`);
    }
    allowlist.push(entry);
  }

  return { perTxCapYocto, dailyCapYocto, largePaymentThresholdYocto, allowlist };
}

/** Parse policy JSON text. Pure; throws PolicyValidationError. */
export function parsePolicyJson(text: string): Policy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PolicyValidationError(
      `the policy file is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  return parsePolicy(raw);
}

/** Load + validate a policy file. Refuses to start on any problem, naming it exactly. */
export function loadPolicy(path: string): Policy {
  if (!existsSync(path)) {
    throw new PolicyValidationError(
      `policy file not found at ${path}. Copy policy.example.json to policy.json and fill in your values.`,
    );
  }
  return parsePolicyJson(readFileSync(path, "utf8"));
}
