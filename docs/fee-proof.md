# Standard zero-fee deployment evidence

The 2 October 2026 review supported zero protocol fees for the recorded Standard Transfer deployments.\
Arc exposed a zero fee getter; Base required verified implementation source and Circle's published fee reference.\
These dated findings do not guarantee future fees: execution must recheck deployment identity and applicable fee conditions.

## Conclusions

- **Arc:** the fee switch and the getter for a 1 USDC transfer returned zero at the pinned block. Preparation and submission recheck the amount-specific getter and require zero.
- **Base:** at 10:05 a.m. EDT, the implementation was reviewed as a Basescan verified exact match of `TokenMessengerV2`, compiler v0.7.6+commit.7338295f, optimizer enabled with 100,000 runs. That version has no minimum-fee getters; Circle's fee reference listed Base Standard Transfers at zero.

Both routes use Standard Transfer with `maxFee = 0`, `destinationCaller = 0`, `minFinalityThreshold = 2000`, and no hooks. Folio separately pays network gas; zero protocol fee does not mean the transaction has no network cost.

## Captured reads

Captured 2 October 2026 at 9:08:21 a.m. EDT. These were read-only RPC calls and documentation checks, with no signing or broadcast. The read tool is [fee-proof.ts](../bridge/scripts/cctp/fee-proof.ts); raw captures are not included.

| Pinned finalized read | Base | Arc |
|---|---|---|
| RPC | `https://mainnet.base.org` | `https://rpc.mainnet.arc.io` |
| `eth_chainId` | 8453 | 5042 |
| `eth_getBlockByNumber("finalized", false)` | 52077680 | 23884197 |
| Block hash | `0x432a7c30cb316864d3728dcc9fc979c5e9689336e0edfa55797f8d9f0a771ab4` | `0x499cb08b0f14208167c8bf953aea475bf343fe5d74bb62df96e32e7481dcf30d` |
| EIP-1967 implementation | `0x555e272506c06e7e559d57418563742afe363ec8` | `0x1ccafdffbc1b7b5c499c97322f961b7d929a41b4` |
| Implementation runtime code Keccak | `0x6c864e374854e06fd5d42b3e9de53ef9ad4d863b83a8c5dd1cf6e2a67fd2b535` | `0x09a9af29d53ac3e54c73284527cf86215cd377486855a33ac3de899a2a77c314` |
| `feeRecipient()` via proxy | `0xBEA3621Ef88850E062cF4baCCaD72877E2c3e4Eb` | `0xDD86B8215163553C96684a5AbCb631f050F8854B` |
| `minFee()` | METHOD_UNAVAILABLE_OR_RPC_ERROR | 0 |
| `minFeeController()` | METHOD_UNAVAILABLE_OR_RPC_ERROR | `0x93d9aA46Df68c6747d7D97BaA67B16e2665304B3` |
| `getMinFeeAmount(1000000)` | METHOD_UNAVAILABLE_OR_RPC_ERROR | 0 |

All getters, storage, and code reads use those numeric blocks. The common proxy is `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`. Reading its EIP-1967 slot `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` identifies the implementation in the final 20 bytes. Both proxy runtime hashes were `0xd2c8d48075d832fb7d07f6db5545a1bee37fdf886325c441a8dd1cef4c9dae99`.

## Evidence and limits

At capture time, [Circle's fee reference](https://developers.circle.com/cctp/concepts/fees) listed both routes at zero basis points for Standard Transfers and Base among deployments without the fee switch. It linked Base to [TokenMessengerV2 revision 7d70310](https://github.com/circlefin/evm-cctp-contracts/blob/7d70310/src/v2/TokenMessengerV2.sol). Circle's [public FAQ](https://www.circle.com/cross-chain-transfer-protocol) also described Standard Transfers as free.

Base's zero fee was not independently established by the RPC getters: unavailable methods are not zero values, and `feeRecipient` identifies a collection role rather than a rate. Sourcify metadata was unavailable, and the review did not reproduce the runtime bytecode. The Base conclusion combines the recorded code hash, the verified-source review, and Circle's documentation.

## Runtime requirements

`FOLIO_BRIDGE_FEE_PROOF_BASE` and `FOLIO_BRIDGE_FEE_PROOF_ARC` identify the reviewed deployments. Preflight must check implementation address and code hash at a fresh finalized block; a changed deployment invalidates the reference. Arc also requires its amount-specific getter to remain zero.

This evidence establishes the recorded fee conditions. Completed deliveries are documented separately in [live transfers](live-runs.md).
