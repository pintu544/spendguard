# SpendGuard guard contract

A minimal [near-sdk-js](https://github.com/near/near-sdk-js) (v2.0.0) contract — the on-chain enforcement layer of SpendGuard. It holds a small NEAR balance on its own testnet account and pays out of that balance through a single **non-payable** method.

## Why non-payable is the whole design

NEAR protocol forbids attaching any deposit to a call signed by a **function-call access key** (`DepositWithFunctionCall`), and asset-moving methods like `ft_transfer` require an attached deposit (exactly 1 yoctoNEAR) — so an agent's scoped key can never execute them (proven in the Gate 1 spike). But a scoped key *can* call a method that takes no deposit. `release` is such a method: it spends the **contract's** balance, not the caller's, so the agent's key — scoped to exactly this contract + this method, with an allowance — can sign it, and nothing else.

That gives three independent enforcement layers: the off-chain policy engine decides, the protocol enforces the key's scope, and this contract enforces its own cap even if the agent key were compromised.

## Methods

| Method | Kind | Arguments | Behaviour |
| --- | --- | --- | --- |
| `init` | `@initialize` | `{ agentAccountId: string, perCallCap: string }` | One-time setup. Stores the authorised agent account id and the per-call cap (yoctoNEAR decimal string, e.g. `"1000000000000000000000000"` = 1 NEAR). Validates both (real account-id shape; cap parses and is > 0). |
| `release` | `@call`, **non-payable** | `{ to: string, amount: string }` | Pays `amount` yoctoNEAR (decimal string) from the contract's own balance to `to`, after the guards below pass. Attaching any deposit panics (SDK default for non-payable calls) — by design. |
| `getConfig` | `@view` | — | Returns `{ agentAccountId, perCallCap }` as stored. For the demo and debugging. |

### `release` guards, in order

Well-formedness first (amounts must parse as yocto integers; `to` must be a NEAR account-id shape), then:

1. **Caller** — predecessor account must equal the stored `agentAccountId`.
2. **Amount** — must be > 0 and <= the stored per-call cap.
3. **Balance** — must be <= the contract account's actual balance.

The guard logic lives in `src/validation.ts` as pure functions with **no SDK imports**; `src/contract.ts` is a thin wrapper that passes in `near.predecessorAccountId()` / `near.accountBalance()` and returns `NearPromise.new(to).transfer(amount)`. Amounts are stored as decimal strings because near-sdk-js state serialisation round-trips bigints as strings — the string is the safe storage form, parsed to `bigint` at every use.

## Tests

The validation layer is covered by the repo-root Vitest suite (`test/guard-validation.test.ts`): wrong caller, caller-before-cap ordering, zero amount, over-cap, exactly-at-cap boundary, over-balance, malformed amounts, invalid recipient, and init validation. Run from the repo root: `npm test`. The on-chain wrapper itself is not unit-tested — it has no logic beyond wiring chain values into the pure layer.

## Build

From this directory:

```
npm install
npm run build        # near-sdk-js build src/contract.ts build/contract.wasm
```

Produces `build/contract.wasm` (plus SDK intermediates in `build/`).

> **VM note (this dev machine only):** near-sdk-js's postinstall downloads a binaryen/QuickJS/wasi-sdk toolchain and extracts it with `tar`; in this VM tar cannot restore the tarballs' file ownership (`Cannot change ownership … Operation not permitted`, extraction itself succeeds but tar exits non-zero and the install aborts). Run the install as `TAR_OPTIONS=--no-same-owner npm install` here. On a normal machine plain `npm install` works.
>
> **Toolchain note:** `package.json` pins `@types/node@^16` as a devDependency on purpose. The SDK's build type-checks with its bundled TypeScript 4.7 and auto-includes every `node_modules/@types` package; left unpinned, npm hoists a current `@types/node` whose declaration files use syntax TS 4.7 cannot even parse, and the build fails inside `node_modules` before reaching the contract source.

## Deploy — later runbook step, NOT done here

Deploying is a chain write and happens from the user's machine (this VM cannot POST to NEAR RPC), in the build-day-1 runbook:

- **Contract account:** a fresh NEAR **testnet** account whose account id becomes the contract's home (deploy target). Its full-access key stays with the human.
- **Deploy + initialise:** deploy `build/contract.wasm`, then call `init` once with:
  - `agentAccountId` — the agent wallet's testnet account id (the account whose scoped key will call `release`);
  - `perCallCap` — yoctoNEAR decimal string, the most one `release` may pay.
- **Fund:** transfer a small testnet NEAR amount to the contract account — that balance is the most SpendGuard can ever pay out in total.
- **Scope the agent key:** create the agent account's function-call access key restricted to this contract's `release` method with a gas allowance (same pattern as the spike).
