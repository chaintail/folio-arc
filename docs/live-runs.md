# Live transfers — 2 October 2026

Arc and Base each delivered 2 USDC to the intended destination account.\
Transaction explorers expose the on-chain delivery; Folio's run records separately report one application credit per transfer.\
These runs predate the 14–15 October deposit-policy changes and do not establish their live enforcement.

## Results at a glance

| Source | Delivered principal | On-chain records |
|---|---|---|
| Arc | 2 USDC | [Destination delivery](https://solscan.io/tx/5uUsxfviXQjFiEh9tebWGPjrSsVCFAgp7yKhK6neyWHewMEERLkH1njXZCSDg4CPLTJ8iMnd5mcTKvDPK15ZEzVf) |
| Base | 2 USDC | [Source burn](https://basescan.org/tx/0x05d2b41ed58642e0eadbd9f5bd527c92ea58c8f3708f17dbf64d5456468fb59c), [destination delivery](https://solscan.io/tx/28s8n6S74z72pjk6f9J7P1YV6modvr8KZAZNz3VocsyFkwnEyGLsEUB1TxZtQ5XJCc5sujgGc58PvhLLSGkjN8Te) |

A successful destination transaction establishes delivery, not the application's balance update or absence of duplicate credit. Those accounting results below are reported by the original run records; raw application captures are not published.

Folio funded the test deposit address `0x9550b183593F3A82bb821968F1387dAd0D4521E9` with 2 USDC on each source chain. Times are Eastern Time.

## Arc transaction detail

| Step | Hash / signature | Result |
|---|---|---|
| Deposit observed (Arc) | 0x4eb1ba2a77df1287969b1a659bdd646a3563f3e1f516d2ecd148c4990ca9fd66 | 2.000000 USDC, event 1, block 23890190 |
| Folio gas top-up 1 | 0x8790e66b58b79df9d4ec7bb43a27bcb4a2d2c5bcc38012aa463e28637d1647c3 | 0.00674892 USDC contribution |
| Approve (exact 2 USDC) | 0xcf5ceda5a78ee51b176d0b8ac1bbb2ff235bf774fb5b77b5bc0ee870c5d80a73 | gas 55,438 @ 20 gwei-eq = 0.00110876 USDC |
| Folio gas top-up 2 | 0xc4ce4ed5b0f298b997dc5aee21abe9833cd584cf1bd37697fcbe99f5ab8fa8be | 0.0096284 USDC contribution |
| Burn (depositForBurn Standard) | 0x03832e55db04202fa47d9edb09b4494792a4e3adc0059da1045b3ca0d1ae3c2b | gas 120,396 = 0.00240792 USDC; nonce 0x30c6…0034 |
| Attestation | message hash 0x36c7d23cd21a600daae0744ea4a0ff4b1c86ef318d063286888aa2520815d93a | complete after ~3 s |
| Destination delivery (receive_message) | 5uUsxfviXQjFiEh9tebWGPjrSsVCFAgp7yKhK6neyWHewMEERLkH1njXZCSDg4CPLTJ8iMnd5mcTKvDPK15ZEzVf | slot 452634743; destination account +2.0 USDC |

## Base transaction detail

| Step | Hash / signature | Result |
|---|---|---|
| Deposit observed (Base) | 0xc7c6d2d71901898e147adcb82b307923196ec9435099177827354cde5a1340ab | 2.000000 USDC, block 52080084 (wallet assigned at 52079000 by a manual assignment row; the deposit arrived before the server assigned the wallet) |
| Folio gas top-up 1 | 0x757810d26ed78e104768c2f32254e8325b53b9f67f4c062306c83cf8db363c65 | 2,048,920,646,700 wei |
| Approve (exact 2 USDC) | 0x8a58d6514880ce5575d03a332c27365397a3b456a6efefe5427ab605182c50ff | gas 55,437 @ 0.005 gwei; charged 282,648,931,308 wei incl. L1 data fee |
| Folio gas top-up 2 | 0x10991219d5b149c14d21fe8dfe518ec3d230c969a891ede201bc7e81917bbfcc | 2,538,085,184,541 wei |
| Folio gas top-up 3 | 0xb3c0376753c42e445990c7fe4e9d41a88e8d944b8178e3a1193cb3bc06b9e77d | 8,415,980,532 wei (shortfall after fee movement; no sizing margin at the time) |
| Burn (depositForBurn Standard) | 0x05d2b41ed58642e0eadbd9f5bd527c92ea58c8f3708f17dbf64d5456468fb59c | gas 104,435 @ 0.005 gwei; charged 532,453,250,231 wei; nonce 0xd52d5bf9…000b0f |
| Attestation | message hash 0xa229136f150930c6c91733b61552fa75e14a5e40a7095d3f35ef8ec953ed13cf | complete 12:06 ET, ~28 min after the burn was submitted (Base finality + Iris) |
| Destination delivery (receive_message) | 28s8n6S74z72pjk6f9J7P1YV6modvr8KZAZNz3VocsyFkwnEyGLsEUB1TxZtQ5XJCc5sujgGc58PvhLLSGkjN8Te | slot 452659348; destination account +2.0 USDC |

## Reported application accounting

| Source | Application observation | Recorded outcome |
|---|---|---|
| Arc | worker (FOLIO_BRIDGE_WORKER=1) | transfer `settled`; one allocation `deposit:5uUsxf…` = 2000000 funding; watcher saw the same signature, no double credit |
| Base | worker (FOLIO_BRIDGE_WORKER=1) | transfer `settled`; receive attempt `confirmed`; one allocation `deposit:28s8n6S7…` = 2000000 funding; no double credit |

The full transaction hashes and destination signatures above support independent on-chain inspection. Personal destination addresses and payer identifiers are omitted. These two completed routes do not establish coverage of every [validation requirement](validation-matrix.md).
