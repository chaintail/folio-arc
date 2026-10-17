# Deposit policies

Each chain has a separate policy for moving deposits into your own Folio balance.\
Revocation stops new authorized transfers while already-burned funds can still settle.\
During development, you and a Folio admin key can each authorize policy changes.

## What the signer may do

Base and Arc deposits use separate policies. You send USDC to your deposit address, and Folio can move it into your Folio balance even while your phone is off. Completion depends on source finality and attestation.

Each deposit policy limits Folio's signing authority:

- It cannot move your money once it is in your Folio balance.
- It cannot make trades on your behalf.
- It cannot send your money anywhere else.

The policy permits approval to Circle's messenger and a burn into your own destination account. It binds the chain, token, recipient, and Standard Transfer settings. The application separately caps sweep principal; the policy has no amount cap.

## Revocation and money in flight

Open the Folio app, go to You, then Policies, and choose Revoke next to the Base or Arc deposit policy. You can set it up again later.

A transfer already burned can still reach your Folio balance. New deposits arriving after revocation stay in your deposit wallet and remain yours.

## Who can change the policy

You remain the wallet owner. During development, either you or a Folio admin key can authorize policy changes; both approvals are not required. This administration authority is separate from the restricted signing key.

Person-only policy administration is planned before public launch. It is not the administration model described here.

## Rules and public policy pages

- [Policy implementation](../wallet/src/evm-sweep-policy.ts)
- [Base deposits policy](https://tryfolio.io/policies/base-deposits/)
- [Arc deposits policy](https://tryfolio.io/policies/arc-deposits/)

The app's consent routes and receipt storage are outside this repository. Local policy tests inspect the generated rules; they do not prove provider enforcement.
