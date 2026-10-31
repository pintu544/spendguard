import { KeyPairEd25519 } from "near-api-js";
import { describe, expect, it } from "vitest";
import {
  SPIKE_SCOPE,
  buildFunctionCallScope,
  buildScopedKeyAction,
} from "../src/spike/access-key.js";

const ONE_NEAR = 10n ** 24n;

describe("buildFunctionCallScope", () => {
  it("accepts the spike scope and converts the allowance to yoctoNEAR", () => {
    const scope = buildFunctionCallScope(SPIKE_SCOPE);
    expect(scope.contractId).toBe("wrap.testnet");
    expect(scope.methodNames).toEqual(["ft_transfer"]);
    expect(scope.allowance).toBe(ONE_NEAR);
  });

  it("rejects a contract id that is not a NEAR account id", () => {
    expect(() =>
      buildFunctionCallScope({ contractId: "Not A Contract!", methodNames: ["ft_transfer"], allowanceNear: "1" }),
    ).toThrowError(/Invalid contractId/);
  });

  it("rejects an empty method list — an unscoped key is the bug we exist to prevent", () => {
    expect(() =>
      buildFunctionCallScope({ contractId: "wrap.testnet", methodNames: [], allowanceNear: "1" }),
    ).toThrowError(/at least one/);
  });

  it("rejects a zero allowance", () => {
    expect(() =>
      buildFunctionCallScope({ contractId: "wrap.testnet", methodNames: ["ft_transfer"], allowanceNear: "0" }),
    ).toThrowError(/positive/);
  });
});

describe("buildScopedKeyAction (offline, via near-api-js itself)", () => {
  it("bakes exactly the scope into the key permission: one contract, one method, capped allowance", () => {
    const kp = KeyPairEd25519.fromRandom();
    const scope = buildFunctionCallScope(SPIKE_SCOPE);
    const action = buildScopedKeyAction(kp.getPublicKey().toString(), scope) as unknown as {
      addKey: {
        accessKey: {
          permission: {
            enum: string;
            functionCall: { receiverId: string; methodNames: string[]; allowance: bigint };
          };
        };
      };
    };
    const perm = action.addKey.accessKey.permission;
    expect(perm.enum).toBe("functionCall");
    expect(perm.functionCall.receiverId).toBe("wrap.testnet");
    expect(perm.functionCall.methodNames).toEqual(["ft_transfer"]);
    expect(perm.functionCall.allowance).toBe(ONE_NEAR);
  });
});
