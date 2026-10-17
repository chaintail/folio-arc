# Folio wallet authorization

Per-chain deposit policies authorize USDC funding on Arc and Base. Each policy allows only token approval and CCTP deposit calls to the person's own destination account, with its chain, contracts, recipient, fee, and finality constraints pinned.

`evm.ts` loads separate signing authorities and checks wallet signer attachments and owner quorums. `evm-sweep-policy.ts` builds and hashes deposit policies. Authorization helpers sign canonical Privy requests with P-256 keys; transport helpers bound requests and redact errors. Permission-proof helpers require complete allowed and denied case coverage.

The package is named `wallet-privy`; the bridge imports its retained API through `wallet-privy/server`. Identity verification and destination transaction-signature verification support the bridge's fee payer. The embedding application supplies credentials and live transports.

From the repository root with Node 24:

```sh
npm ci
npm run typecheck
npm test
```

The three wallet test files cover EVM authority separation, deposit policy golden data, authorization signatures, and supported key encodings. They use local transports and public test vectors; no credentials or live provider connection are required.

The authorization vector uses the public P-256 scalar-one key, never an operational credential. Deposit golden data uses a public fixture destination. Neither should receive funds or grant authority.

See [the bridge extraction audit](../bridge/README.md#edits-versus-the-monorepo) for source provenance and the address/digest replacements. Application delegation policies, trading signers, payment policies, and policy-update tools are excluded.

License: Apache-2.0.
