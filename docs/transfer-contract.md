# Durable transfer contract

A transfer pins the customer's principal and destination before signing.\
Durable records preserve transaction identity across retries and restarts.\
Application credit follows verified settlement and can be replayed after a crash.

## Normal path

`planned` → `approval_pending` → `approved` → `burn_pending` → `burn_confirmed` → `attested` → `delivery_submitted` → `settled`

Uncertainty states are recovery branches, not required steps in a successful transfer.

| Situation | Recovery transition |
|---|---|
| Burn submission has no conclusive receipt | `burn_pending` → `burn_uncertain` |
| Chain evidence confirms the retained burn | `burn_uncertain` → `burn_confirmed` |
| Chain evidence establishes burn failure | `burn_pending` or `burn_uncertain` → `approved`; record gas before retrying |
| Destination submission has no conclusive outcome | `delivery_submitted` → `delivery_uncertain` |
| Destination receipt confirms delivery | `delivery_uncertain` → `settled` |
| Destination reconciliation permits another delivery attempt | `delivery_uncertain` → `attested` |
| A nonterminal transfer requires an operator hold | Current state → `blocked`, with a reason |

Recipient and amount never change after `planned`. A pending or uncertain burn blocks another sweep for that wallet and chain. Missing responses alone do not authorize a new burn.

A verified finalized destination receipt permits `settled`. Application credit is replayable from the durable settlement record; an attestation or a submitted transaction is insufficient.

## Durable records

The shared implementation is `bridge/src/bridge/transfer-record.ts`. Amounts are integer decimal strings.

| Record | Contents |
|---|---|
| `bridge_deposit_event` | Chain, wallet, transaction/event identity, native amount, normalized amount and remainder, block, sender, classification, covering sweep. |
| `bridge_sweep` | Person, wallet, triggering event, pinned principal and destination, creation time, state and hold reason. |
| `bridge_attempt` | Operation, request ID, transaction hash, nonce, state, actual gas charge, and supporting evidence. |
| `bridge_transfer` | Source domain, burn identity, message hash and nonce, attestation, destination signature, settlement, and retry schedule. |

Attempt states include `prepared`, `prepared_dry_run`, `signed`, `submitted`, `uncertain`, `confirmed`, and `failed`.

## Principal and gas

The ledger separates customer principal from Folio contributions, gas charges, and the remaining Folio balance. Arc uses raw 18-decimal integers because USDC serves as both principal and gas.

Before signing, Folio's residual contribution must cover the transaction's reserved gas; otherwise a top-up is needed. The sweep burns pinned customer principal, never the entire observed wallet balance. Failed attempts still incur recorded gas charges.
