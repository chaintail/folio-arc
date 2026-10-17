# Bridge operation

The observer checks finalized balances before reading attribution logs.\
The executor keeps customer principal separate from Folio-paid gas and reconciles uncertain transactions before retrying.\
This repository contains bridge modules and tests; application scheduling, account storage, and server boot remain outside it.

## Behavior

1. Read the finalized head and the wallet balance at that block.
2. Compare the balance with the ledger. An equal balance advances the cursor without a log scan; an increase triggers paged attribution reads.
3. Stop planning if the balance falls unexpectedly or incoming events cannot explain it.
4. Pin the entire eligible principal and destination account. A principal or cost cap holds the sweep rather than sending a partial amount.
5. Supply Folio gas, approve USDC, burn, obtain the attestation, and deliver. Only verified settlement permits credit.

Base balances use six-decimal token units. Arc native balances use 18 decimals; the ledger preserves precision and separates customer principal from Folio contributions. Base gas accounting includes the receipt's L1 data fee.

See the [transfer contract](transfer-contract.md), [fee evidence](fee-proof.md), and [deposit policies](deposit-policies.md).

## Local checks and tools

After dependency installation, `npm run typecheck` and `npm test` check the extracted bridge and wallet packages without credentials. [Coverage](validation-matrix.md) identifies the relevant tests.

Tools under `bridge/scripts/cctp/` default to read-only checks or dry runs. Signing, provider mutations, and broadcasts require their explicit flags and runtime inputs. [The bridge guide](../bridge/README.md) describes their entry points. These tools do not supply the missing application server.

## Application configuration reference

These settings describe Folio's application integration; setting them does not start a complete service from this repository. Names below identify runtime inputs, not credentials.

| Runtime names | Purpose |
|---|---|
| `FOLIO_BRIDGE_SOURCE` | Enables source observation in live mode; off by default. |
| `FOLIO_BRIDGE_EXECUTE` | Enables source/top-up broadcasts with the other live gates; off by default. |
| `FOLIO_BRIDGE_WORKER` | Enables destination reconciliation and credit. |
| `FOLIO_BRIDGE_ENABLE_BASE`, `FOLIO_BRIDGE_ENABLE_ARC` | Per-chain enablement within the source feature. |
| `FOLIO_BASE_RPC_URL`, `FOLIO_ARC_RPC_URL` | Optional source RPC endpoints; wrong chain identity disables the route. |
| `FOLIO_BRIDGE_MIN_BASE_6`, `FOLIO_BRIDGE_MIN_ARC_6` | Individual deposit trigger in six-decimal units; default 20 USDC. Historical live runs used a lower threshold. |
| `FOLIO_BRIDGE_PAUSE_BASE`, `FOLIO_BRIDGE_PAUSE_ARC` | Pause new work while submitted transactions continue reconciliation. |
| `FOLIO_BRIDGE_SCAN_PAGE_BLOCKS`, `FOLIO_BRIDGE_SCAN_PAGE_BLOCKS_BASE`, `FOLIO_BRIDGE_SCAN_PAGE_BLOCKS_ARC` | Log page size, 1–2000 blocks; default 1000. |
| `FOLIO_BRIDGE_SCAN_CHUNKS`, `FOLIO_BRIDGE_SCAN_CHUNKS_BASE`, `FOLIO_BRIDGE_SCAN_CHUNKS_ARC` | Pages per observation pass, 1–64; default 1. |
| `FOLIO_BASE_GAS_WALLET`, `FOLIO_ARC_GAS_WALLET` | Folio gas payer addresses, distinct from deposit wallets. |
| `FOLIO_BASE_GAS_WALLET_KEY`, `FOLIO_ARC_GAS_WALLET_KEY` | Payer signing credentials, loaded only for gated execution. |
| `FOLIO_BRIDGE_TOPUP_CAP_BASE_RAW`, `FOLIO_BRIDGE_TOPUP_CAP_ARC_RAW` | Cumulative Folio contribution and external payer cost ceilings, in native raw18 units. |
| `FOLIO_BRIDGE_FEE_PROOF_BASE`, `FOLIO_BRIDGE_FEE_PROOF_ARC` | Reviewed deployment references required before preparation. |
| `FOLIO_FEE_PAYER_ADDRESS`, `FOLIO_FEE_PAYER_WALLET_ID` | Destination fee payer identifiers. |
| `FOLIO_EVM_AUTHORIZATION_KEY`, `FOLIO_EVM_KEY_QUORUM_ID` | EVM signing authority, separate from destination fee-payer authority. |
| `FOLIO_EVM_PERMISSION_PROOF` | Verified record binding the signer key, quorum, policy template, and chains. |
| `FOLIO_BRIDGE_MAX_PRINCIPAL_6` | Application cap on the whole sweep; the Privy policy itself has no amount cap. |
| `FOLIO_BRIDGE_SOURCE_FEE_CAP_BASE_RAW`, `FOLIO_BRIDGE_SOURCE_FEE_CAP_ARC_RAW` | Per-attempt source cost ceilings, including Base L1 fee reservation. |
| `FOLIO_BRIDGE_DELIVERY_MAX_COST_LAMPORTS` | Destination fee and nonce-account rent ceiling per attempt. |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_JWKS_URL` | Provider authentication and identity-verification inputs. |

## Recovery and authority details

The observer adapts log-page size when a provider refuses a range. Its shared read budget bounds catch-up work. Cursors advance only after a fully ingested page or a verified equal balance; unexplained balances hold new planning.

A SQLite source lease serializes mutations across processes, with renewal every 20 seconds and a five-minute crash timeout. An uncertain submission retains its transaction hash for reconciliation. A top-up counts only after a finalized receipt matches sender, recipient, value, and nonce.

A missing or mismatched permission proof prevents signer construction. Rotating the signer key or changing the policy template requires a new proof. Cost holds preserve funded deposits for later retry.

Policy consent, receipt persistence, and account crediting belong to the private application integration. The published policy rules constrain what the signer may request; local policy tests do not establish live provider enforcement.
