# Folio bridge

This package is a library with runnable offline tests, not a standalone application or transfer service. The embedding application supplies signing, scheduling, person storage, and balance credit.

Circle CCTP V2 moves USDC from Arc or Base into a person's Folio balance. Folio funds network fees; the deposit policy binds signing to the person's destination account.

## Run locally

Use Node 24. From the repository root:

```sh
npm ci
npm run typecheck
npm test
```

Typechecking covers all retained source, scripts, and tests. Tests use local fixtures and temporary databases, require no credentials, and cover source observation, planning, signing guards, destination settlement/recovery, wallet authorization, operator guards, and shim boundaries. No server is started.

## Source guide

- `source-observer.ts` reads finalized deposits and reconciles balances; `deposit-intent.ts` manages readiness and checking intervals.
- `transfer-record.ts` persists planning, attempts, state transitions, and settlement; `source-executor.ts` validates signed transactions before submission.
- `source-gas.ts` accounts for Folio gas contributions and per-chain costs; `source-rpc.ts` provides source-chain reads and submission.
- `deposit-permission.ts` checks consent receipts and live policy ownership; `deposit-readiness.ts` checks the destination, authority, and sponsorship.
- `attestation.ts` polls Circle; `message.ts` validates message identity; `delivery.ts` verifies finalized delivery receipts.
- `worker.ts` coordinates durable delivery and settlement. The embedding application supplies the signing, scheduling, person-store, and balance-credit ports.
- `src/shims/` contains the narrow dependencies needed by this extraction. The trading engine and application server are absent.

The worker persists a verified receipt and `settled` state before calling the application's credit callback, then acknowledges completion. Credit must be idempotent by sweep ID: a failed callback or a crash after credit but before acknowledgment can replay it. [The destination worker tests](test/bridge/destination-worker.test.ts) exercise finalized receipt checks and recovery from retained evidence without new RPC reads. Planner fixture helpers only arrange state for planner assertions.

Auxiliary modules: `source-fixture.ts` supplies an imported funding-interface fixture; `capture-fixture.ts` exposes an opt-in public-read capture function, not a CLI. `source-7702.ts` and `scripts/cctp/read-7702.ts` compare a separately authorized transaction format; they are not the source executor's transfer path. The wallet's retained `loadPaySigner` checks separation from deposit and fee-payer authorities; it is neither exported by `wallet-privy/server` nor called by the bridge, and payment policies are excluded.

## Shim boundary

Shim headers identify their original modules. “Identical signature” refers to retained bridge-facing exports, not complete module compatibility. The shims perform real validation and derivation: they do not bypass consent, address checks, or read-budget enforcement.

[obligation.ts](src/shims/obligation.ts) derives three owner-controlled destination accounts. [Delivery verification](src/bridge/delivery.ts) excludes transfers from those accounts, their owners, or their authorities from external deposit totals; counting an internal movement as a new deposit would overstate credit. The public program and market constants are therefore part of receipt accounting, even though trading is absent. Derivation uses the original vanilla PDA seeds: one-byte tag zero, one-byte account ID, owner, market, and two zero public keys. No account is created or traded by this shim.

The constants and account mapping come from the source revision recorded below; fixed address vectors in [the boundary tests](test/shims/boundaries.test.ts) were computed against the original SDK's `VanillaObligation.toPda` implementation using the public fixture owner. The extraction implements that seed layout with the address primitives already required by the bridge, without adding the trading SDK. The other shims retain only the used namespace, receipt, readiness, logging, and RPC-batching interfaces.

## Operator scripts

Executable entry points under `scripts/cctp/`:

- `read-source.ts` and `read-7702.ts`: local dry runs; public reads/simulation only with `--rpc-read`.
- `fee-proof.ts` and `gas-round2.ts`: public mainnet reads/simulation on invocation; no signing or broadcasting.
- `run-source.ts`, `run-control.ts`, `sign-with-key.ts`, `privy-evm-key.ts`, and `privy-evm-prove.ts`: gated operator commands; inspect each command's argument guards before use.

`private-file.ts` and `privy-common.ts` are imported helpers, not commands. The four `*.test.ts` files run through `npm test`. Similarly, source modules such as `director-delivery.ts` export library functions and do not start a service when invoked.

From the root, this credential-free command performs no network reads or file writes:

```sh
node --import=tsx bridge/scripts/cctp/read-source.ts --dry-run
```

It prints JSON containing `result: "DRY_RUN"`, `rpcRead: false`, `signing: false`, and `broadcast: false`; gas measurements remain unmeasured. Public-read modes can contact mainnet RPC endpoints; the test command does not.

Commands that bind an existing person, including the Privy path of `run-source.ts` and `privy-evm-prove.ts`, expect an existing Folio database with `person_wallets` bindings and verified `permission_receipt` rows. This extraction creates bridge-owned tables only; it does not provision those application tables, people, consent receipts, or provider credentials. An empty database is not a runnable live setup.

`read-source.ts --rpc-read --owner <address>` and `gas-round2.ts --owner <address>` require an explicit destination owner. `run-control.ts` requires `owner` in its input JSON; non-Privy `run-source.ts` runs require matching `--owner`. Destination ownership is still checked against the stored sweep and token account.

Execution and signing require explicit operator flags. A dry run can still write local output or generate a local authorization key, as documented by that script's options. `fee-proof.ts` and `gas-round2.ts` print their results to stdout. These scripts are operator tools, not a deployed service.

## Edits versus the monorepo

Source revision: `b06521eb1ab66f08b021e5266c15f56782b38a41`. Extraction retains 25 bridge source files and 15 CCTP script/test files; no repository history is included.

- Imports now resolve within this workspace and its narrow shims. Logging and proof verification retain their behavior; namespace, receipt, readiness, address derivation, and RPC batching dependencies are extracted to the used interfaces. Batching retains exact-slot convergence and incomplete-response rejection.
- `capture-fixture.ts`, `transfer-record.ts`, and `worker.ts` have product-language comment edits. `config.ts` removes a reference to unrelated trading. `gas-round2.ts` renames a local result variable. The wallet policy comment calls the destination a USDC account.
- `source-fixture.ts`, `test/bridge/support.ts`, `policy-live-check.test.ts`, `privy-evm-prove.test.ts`, `privy-guards.test.ts`, and the wallet deposit-policy golden file replace historical owner/account addresses with public fixture addresses. Encoded recipient bytes and instantiated policy digests were updated together; template digests are unchanged. The fixture owner is derived from a public all-ones 32-byte Ed25519 seed and must never receive funds.
- `director-delivery.ts` accepts a valid explicit owner instead of a historical hard-coded owner; stored owner, burn, route, amount, fee, and execution checks remain.
- `read-source.ts` and `gas-round2.ts` take `--owner`; `run-control.ts` binds to input `owner`; `run-source.ts` validates supplied owners and requires the non-Privy sweep owner to match. No historical operational owner is embedded.
- `fee-proof.ts` and `gas-round2.ts` print JSON instead of writing into a private documentation tree.
- `privy-guards.test.ts` omits assertions and imports for the excluded fee-payer-policy updater. `run-control.test.ts` supplies the explicit owner and types its RPC doubles with the required generic return signature. Additional tests cover the changed owner guards and shim boundaries.
- The wallet server export surface contains only the retained interfaces. Its deposit/authorization tests and public P-256 scalar-one vector are retained; unrelated delegation support and policy-update tools are excluded.
- Review additions document runtime and shim boundaries, add real-worker destination settlement/recovery tests, and retain the balance-first observer regression with namespace/person-scope import rewrites and a neutral contract heading. The two-connection planner test is named as sequential planning; auxiliary module notes do not change behavior.

All packages use Apache-2.0. These tests establish the extracted contracts and safety checks; they do not run a funded transfer or operate the full Folio application.
