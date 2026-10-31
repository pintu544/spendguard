import { nearToYocto } from "near-api-js";

/**
 * Parse a human NEAR amount ("0.01") to yoctoNEAR (bigint), rejecting
 * anything that is not a plain non-negative decimal before it reaches
 * the library's template-typed parser.
 */
export function parseNearToYocto(amountNear: string): bigint {
  const trimmed = amountNear.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(
      `Invalid NEAR amount "${amountNear}" — expected a decimal like "0.01" or "1".`,
    );
  }
  return nearToYocto(trimmed as `${number}`);
}
