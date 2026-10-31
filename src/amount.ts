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

const YOCTO_PER_NEAR = 10n ** 24n;

/**
 * Format yoctoNEAR (bigint) as a human NEAR decimal string, exactly:
 * trailing fractional zeros are trimmed ("0.25", "1", "1.5"). Pure bigint
 * math — no floats, so a formatted amount always parses back to the same
 * yocto value with {@link parseNearToYocto}.
 */
export function formatYoctoAsNear(yocto: bigint): string {
  if (yocto < 0n) throw new Error(`Cannot format a negative yocto amount: ${yocto}`);
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = yocto % YOCTO_PER_NEAR;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(24, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}
