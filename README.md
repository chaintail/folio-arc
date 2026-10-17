# Folio: a treasury agent for people.

Folio is a savings and investing app.\
Fund it with USDC from Arc or Base; Circle CCTP V2 moves it into your Folio balance, with Folio paying network fees.\
ChatGPT can read holdings and write research under permissions you can revoke.

The hosted ChatGPT connection uses Paper, Folio's simulated investing environment, where research writes cannot access live account data.

[Try Folio](https://tryfolio.io) · [Connect ChatGPT](https://chatgpt.tryfolio.io) · [Policies](https://tryfolio.io/policies/)

Video: [Folio for Tameion, 2:45](https://static.tryfolio.io/folio-tameion-v1.mp4)

## What is here

- CCTP V2 funding with durable recovery, Folio-paid gas, and per-person Privy deposit policies.
- An OAuth authorization server, MCP resource, and restricted core; the local connector uses test accounts and data.
- Documentation of the [connector's security boundaries](docs/connector-hardening.md).

## Built during Tameion: 2 Oct to 17 Oct 2026

- **2 Oct:** Arc and Base each delivered 2 USDC; application records report one credit per transfer. [Results and transactions](docs/live-runs.md).
- **10 Oct:** balance-first observation at finalized heads.
- **12 Oct:** connector resource moved to `chatgpt.tryfolio.io`.
- **14–15 Oct:** per-chain policy pages, consent receipts, and grant/verify/revoke lifecycle.

## How it works

A person funds their embedded EVM wallet. Folio's restricted signer approves USDC and burns it toward that person's destination. The observer checks finalized balances; Folio supplies gas and delivers Circle's attested message. Credit follows verified settlement.

The transfer settles into the person's Folio account (a Solana USDC account; CCTP domain 5).

ChatGPT reaches Folio through OAuth → MCP → restricted core. It has no trading, transfer, or signing authority. See [architecture](docs/architecture.md) and the [transfer contract](docs/transfer-contract.md).

## Circle tools used

| Tool | Implementation |
|---|---|
| CCTP V2 Standard Transfer | [Burn](bridge/src/bridge/source-calls.ts), [attestation](bridge/src/bridge/attestation.ts), [message validation](bridge/src/bridge/message.ts), [delivery](bridge/src/bridge/delivery.ts) |
| Arc USDC as gas | [Separate principal and gas accounting](bridge/src/bridge/source-gas.ts) |
| USDC on Base and Arc | [Restricted deposit policy](wallet/src/evm-sweep-policy.ts) |
| Circle fee reference | [Dated zero-fee deployment evidence](docs/fee-proof.md) |

Roadmap: pending xStocks on Arc.

## Run what runs

Bridge and wallet require Node 24; local tests need no credentials:

```sh
npm ci
npm run typecheck
npm test
```

See [bridge operation](docs/bridge.md) and [coverage](docs/validation-matrix.md). The full app server is excluded.

The connector runs separately from npm on Linux: Docker Engine/Compose, Python 3, OpenSSL, `ss` (iproute2), and `curl` are required. Preparation needs permission to assign private state to UID/GID 1000.

```sh
cd connector
./scripts/preflight.sh
./scripts/prepare-runtime.sh
docker compose build
docker compose up -d --wait as mcp core tls-fixture
./scripts/container-acceptance.sh
```

Before repeating acceptance, run `./scripts/reset-local.sh` from `connector/`, then prepare/start/test again. Reset clears local account state, preserving credentials; `docker compose down -v` alone preserves that state.

See [local setup](connector/README.md) and [connecting ChatGPT](docs/connect-chatgpt.md). Bridge tools default to read-only checks or dry runs; signing and broadcasting require explicit flags.

## Deposit policies

Each deposit policy limits Folio's authority:

- It cannot move your money once it is in your Folio balance.
- It cannot make trades on your behalf.
- It cannot send your money anywhere else.

Read about [revocation, money in flight, and development policy administration](docs/deposit-policies.md).

## Scope, license, and security

The mobile app, trading/account services, production connector adapter/configuration, credentials, and raw captures are [outside this repository](docs/not-here.md).

Copyright 2026 Chaintail. [Apache-2.0](LICENSE) · [Third-party notices](NOTICE) · [Private vulnerability reporting](SECURITY.md).
