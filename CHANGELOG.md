# Changelog

This repository was published on 17 October 2026 as an extraction from Folio's private codebase, so its own commits all carry that date.
The dates below are when each change first landed in Folio.

## Week of 28 September to 4 October

- **2 Oct:** Funding from Base and Arc into a Folio account became possible end to end, with a durable transfer record that survives restarts and settles each transfer exactly once.
- **2 Oct:** Deposits are read from the chain in bounded chunks with a saved position, so a restart resumes where it stopped and a provider limit holds the transfer instead of losing it.
- **2 Oct:** Folio covers the network fee for the cross-chain step and sizes the gas top-up with a margin, so fee movement does not force a second wait for finality.
- **2 Oct:** Signing for the source chain moved server-side through Privy, with a separate EVM authority and a per-person sweep policy; key files in PEM, PKCS8, SEC1 and wallet-auth forms are accepted.
- **2 Oct:** Live runs from Arc and from Base each delivered 2 USDC, settled and credited once. Details are in [docs/live-runs.md](docs/live-runs.md).
- **2 Oct:** Deposits carry the time the block was produced, never the time Folio noticed them.
- **3 Oct:** An incoming deposit is shown as available only after the matching credit is recorded in the person's Funding account.
- **3 Oct:** The deposit watcher follows the owner's own USDC account rather than whichever account the provider lists first.

## Week of 5 to 11 October

- **5 Oct:** Base and Arc deposit addresses are shown even while execution is held; the observer makes fewer calls and backs off when the provider is slow.
- **5 Oct:** A person's own cycle no longer waits on the cross-chain lease.
- **6 Oct:** Deposit intents: a person starts a deposit, Folio checks readiness and sponsorship, and an interrupted deposit can be recovered. Status and receipts report only what happened.
- **6 Oct:** Transfers check readiness first, review instantly, and quietly prepare again when an attempt has expired.
- **7 Oct:** Wallet authentication from Privy is decrypted correctly (HPKE).
- **7 Oct:** The server checks its required capabilities before it starts serving.
- **7 Oct:** Source transfers interrupted mid-way are recovered from durable transaction evidence.
- **8 Oct:** The permission proof is now a verifiable record; a mismatch refuses to use the EVM signer.
- **8 Oct:** A person grants the signer through a prepare and confirm step, and the old server-side owner-key exchange was removed.
- **8 Oct:** Holds caused by a missing signer are visible and classified, and are released when the signer is attached.
- **8 Oct:** Connector experiments for authentication and setup were gathered into the connector tree, including an exact-weight editor for ten-stock research portfolios.
- **10 Oct:** Balance-first observation: Folio reads balances at finalized heads and uses logs only to attribute a deposit.
- **10 Oct:** Log reads adapt their page size when a provider refuses a range.
- **10 Oct:** Spend caps hold the sweep, never the deposit address.
- **10 Oct:** The deposit chooser shows only the typical arrival time; deposit notices sit behind the bell on Home, with one open intent per chain.

## Week of 12 to 17 October

- **12 Oct:** Base and Arc deposits opened to everyone.
- **12 Oct:** The connector's MCP resource is served at the bare origin on chatgpt.tryfolio.io, with `/mcp` kept as an alias, and its metadata advertises the `openid` and `offline_access` scopes.
- **14 Oct:** Wire shapes, error codes and fixtures for deposit policies were fixed as a contract.
- **14 Oct:** Policy information pages for Base, Arc and Folio Pay were published on tryfolio.io.
- **14 Oct:** A deposit watch starts when the person starts the deposit (reveal, copy, open wallet); the Base estimate is under 30 minutes.
- **15 Oct:** Per-chain deposit policies owned by a quorum, checked live before a deposit is accepted.
- **15 Oct:** The permissions registry: consent receipts and grant, verify and revoke routes, plus a policy reset.
- **15 Oct:** Folio Pay on Base: a pay grant, a policy row with revoke, and signing, broadcast and gas for the Base payment, with its signer key bootstrapped under a quorum.
