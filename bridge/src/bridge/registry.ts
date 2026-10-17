import { address } from '@solana/kit';
/** Circle mainnet registry reviewed 2026-10-02. RPC verification is separate evidence. */
export const CCTP = {
  destinationDomain: 5,
  messageTransmitter: address('CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC'),
  tokenMessengerMinter: address('CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe'),
  usdc: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  tokenProgram: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  associatedTokenProgram: address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
  systemProgram: address('11111111111111111111111111111111'),
  mainnetGenesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  arc: { domain: 26, burnToken: '0x0000000000000000000000003600000000000000000000000000000000000000', tokenMessenger: '0x00000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d' },
  base: { domain: 6, burnToken: '0x000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913', tokenMessenger: '0x00000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d' },
} as const;
export const PUBLIC_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
export const PUBLIC_BASE_RPC = 'https://mainnet.base.org';
