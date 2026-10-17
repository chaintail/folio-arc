# Validation coverage

Local tests exercise transaction construction, deposit accounting, policy rules, and source recovery.\
The two historical live runs record delivery; application credit is a separate reported result.\
Provider enforcement, private application integration, and every failure branch require evidence beyond those checks.

## What is covered where

| Area | Where to inspect | Evidence boundary |
|---|---|---|
| Route, recipient, and Standard call construction | `bridge/test/bridge/calls.test.ts` | Local transaction/account fixtures; not live delivery. |
| Observation, eligibility, precision, and gas | `observer.test.ts`, `planner.test.ts`, `gas.test.ts` in `bridge/test/bridge/` | Local event and ledger checks. |
| Source execution and readiness recovery | `executor.test.ts`, `deposit-intent.test.ts`, `readiness-recovery.test.ts` in `bridge/test/bridge/` | Controlled failure and restart checks. |
| Policy rules and authorization signatures | `bridge/test/bridge/evm-policy.test.ts`; `wallet/test/{evm,authorization-signature,authorization-key-forms}.test.ts` | Local rule evaluation and signing vectors; not provider enforcement. |
| Deployment fee conditions | [Fee proof](fee-proof.md) | Dated RPC reads and source review. |
| Completed Arc and Base routes | [Live transfers](live-runs.md) | Explorer-visible delivery; application credit reported separately. |
| Consent routes, account crediting, and broader app regressions | Private Folio application | Outside the published test suite. |

This map identifies test locations and evidence scope; it is not an executed test report. The [bridge guide](../bridge/README.md) describes local commands. Each test covers specific assertions, not every requirement in its area.

Authenticated provider checks must distinguish read-only inspection, provisioning, and sign-only policy evaluation from broadcasting. A local evaluator accepting or rejecting a request does not establish that Privy enforced it.

## Appendix: requirement IDs

These IDs preserve traceability to individual requirements. The table defines expected behavior; it does not assign passing status.

| ID | Requirement |
|---|---|
| FND-001 | Record runtime, dependency versions, and baseline checks. |
| FND-002 | Identify wallet, funding watcher, and durable-job integration boundaries. |
| FND-003 | Reject mismatched chain IDs, domains, and destination configuration. |
| FND-004 | Verify source contracts and destination accounts against deployment state. |
| FND-005 | Compile source and destination code with compatible dependencies. |
| FND-006 | Default to no broadcast; enforce explicit execution gates and caps. |
| FND-007 | Attribute Base USDC deposits to the assigned recipient. |
| FND-008 | Detect Arc native USDC deposits. |
| FND-009 | Count an Arc deposit once across overlapping event representations. |
| FND-010 | Preserve exact six-/18-decimal amounts and remainders. |
| FND-011 | Hold individual deposits below the configured trigger. |
| FND-012 | Accept an individual deposit at the trigger. |
| FND-013 | Do not combine subminimum events to satisfy the trigger. |
| FND-014 | Sweep eligible accumulated principal after a qualifying event. |
| FND-015 | Mark all covered events without creating a second sweep. |
| FND-016 | Keep deposits arriving after amount pinning for later work. |
| FND-017 | Separate eligibility and execution state by chain. |
| FND-018 | Exclude operational top-ups, self-movements, and wrong tokens. |
| FND-019 | Deduplicate reordered events and overlapping scans. |
| FND-020 | Resume observation and planning safely after restart. |
| FND-021 | Reject failed or noncanonical events. |
| FND-022 | Record paused-chain deposits and resume eligible work. |
| FND-023 | Exclude gas contributions and cap the whole sweep without partial sends. |
| FND-024 | Verify destination token-account address, mint, program, and authority. |
| FND-025 | Create a missing correct destination account idempotently. |
| FND-026 | Reject owner addresses, wrong accounts, and malformed recipients. |
| FND-027 | Round-trip destination addresses through bytes32 without corruption. |
| FND-028 | Encode the fixed recipient and exact Standard Transfer settings. |
| FND-029 | Approve only the intended spender; distinguish approval from burn. |
| FND-030 | Keep gas charges separate from customer principal, including failures. |
| FND-031 | Refuse unknown/nonzero protocol fees and unsupported transfer modes. |
| FND-032 | Verify signer provisioning for new and existing wallets. |
| FND-033 | Retain user wallet ownership while allowing constrained offline signing. |
| FND-034 | Privy policy binds chain, method, target, token/spender, recipient, and Standard settings; it has no amount cap. The application separately caps sweep principal. |
| FND-035 | Reject altered routes, recipients, calls, and signing methods at the correct layer. |
| FND-036 | Prevent broader rules from bypassing recipient restrictions. |
| FND-037 | Stop new signing on revocation; allow already-burned funds to settle. |
| FND-038 | Document and verify current policy-administration authority. |
| FND-039 | Do not create a cross-chain transfer from approval alone. |
| FND-040 | Recover a submitted burn after the client disconnects. |
| FND-041 | Retrieve attestation from durable burn identity after restart. |
| FND-042 | Select only the message matching the intended transfer. |
| FND-043 | Preserve state under pending responses and bounded retry/backoff. |
| FND-044 | Distinguish protocol message recipient from customer token recipient. |
| FND-045 | Reconcile lost responses before any new execution. |
| FND-046 | Prevent duplicate burns after provider idempotency expires. |
| FND-047 | Serialize competing workers and sweeps. |
| FND-048 | Recheck pauses before submission without canceling existing transactions. |
| FND-049 | Build and simulate delivery with the Folio fee payer. |
| FND-050 | Deliver the Base route into the pinned destination account. |
| FND-051 | Deliver the Arc route into the pinned destination account. |
| FND-052 | Resume destination work after restart. |
| FND-053 | Recognize successful delivery after a lost response. |
| FND-054 | Retry destination failures without another source burn. |
| FND-055 | Recognize delivery by another permitted relayer. |
| FND-056 | Credit only after verified settlement, never at attestation/submission. |
| FND-057 | Prevent duplicate application credit across watcher and worker. |
| FND-058 | Reconcile burn, delivery, residuals, and credited principal. |
| FND-059 | Assess optional SDK behavior against its actual version. |
| FND-060 | Check private application funding/trading regressions separately. |
| FND-061 | Present detected, processing, and settled states accurately. |
| FND-062 | Record reproducible results without credentials or broader unsupported claims. |
