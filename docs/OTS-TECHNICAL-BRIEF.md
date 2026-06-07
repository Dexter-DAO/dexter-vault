---
title: "Tab: Technical Brief"
subtitle: "On-chain non-custodial spending authorizations on Solana"
date: 2026-05-28
audience: Engineers, CTOs, technical reviewers
status: Draft v1
---

# Tab: Technical Brief

**Tab** is a reference implementation of the **Open Tabs Standard (OTS)**, an on-chain protocol for non-custodial, non-escrow spending authorizations on Solana. Funds never leave the buyer's wallet. Seller protection comes from an on-chain invariant that locks the buyer's withdrawal path while any authorization (a "tab") is outstanding.

The reference implementation is live on Solana mainnet at program ID `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`.

This document is for engineers and CTOs evaluating Tab as a payments primitive. It describes what it does, how it does it, what's verifiable today, and the known caveats that affect production deployment.

---

## The primitive in one paragraph

A buyer creates a Swig smart-wallet whose root authority is a passkey-secured WebAuthn key, and binds that wallet to a vault PDA on Solana mainnet. The vault PDA delegates a bounded session role to Dexter (token-spend cap, TTL, program scope). The buyer can spend through the session role indefinitely without per-transaction signatures, while the vault program enforces a single on-chain invariant: **withdrawal of buyer funds is blocked while any tab is outstanding.** Tabs are tracked by a `pending_voucher_count` field on the vault PDA, incremented when a tab opens and decremented when it settles. The buyer's own passkey signature is rejected by the program if it would finalize a withdrawal while the count is greater than zero.

This inverts the standard escrow model. Instead of locking the *funds*, the program locks the *exit path*.

---

## State machine

The vault program (`programs/dexter-vault/src/`) exposes nine instructions over a single account type — eight for spending, recovery, and key rotation, plus `prove_passkey`, a read-only proof-of-control primitive for non-custodial identity. The Vault PDA holds these state fields:

```rust
pub struct Vault {
    pub passkey_pubkey: [u8; 33],            // secp256r1 WebAuthn key (root authority)
    pub swig_address: Pubkey,                // bound Swig smart-wallet
    pub cooling_off_seconds: i64,            // optional delay before finalize (default 0 = instant)
    pub pending_voucher_count: u32,          // outstanding tabs, the gate
    pub pending_withdrawal: Option<PendingWithdrawal>,
    pub supabase_user_id: [u8; 16],
    pub dexter_authority: Pubkey,            // the only key permitted to move the counter
}
```

### Instruction surface

| Instruction | Authority | Purpose |
|---|---|---|
| `initialize_vault` | Paid setup (records the counter authority) | Create vault PDA, bind passkey pubkey and counter authority, set cooling-off period |
| `set_swig` | Passkey | Bind the Swig smart-wallet to this vault (one-shot) |
| `settle_voucher` | Recorded counter authority (`has_one`) | Increment/decrement `pending_voucher_count` |
| `request_withdrawal` | Passkey | Record intent to withdraw (no funds move) |
| `finalize_withdrawal` | Passkey | Release funds, gated by counter and cooling-off |
| `force_release` | Passkey | Buyer recovery: clear a stuck tab after a 7-day grace (no funds move) |
| `rotate_passkey` | Buyer's current passkey | Replace the root passkey |
| `rotate_dexter_authority` | Current counter authority | Replace the counter authority |

### The gate

In `finalize_withdrawal.rs`:

```rust
let elapsed = now.saturating_sub(pending.requested_at).max(0);
require!(elapsed >= vault.cooling_off_seconds, VaultError::CoolingOffNotElapsed);
require!(vault.pending_voucher_count == 0, VaultError::PendingVouchersExist);
```

Two preconditions to release funds, enforced independently:
1. Cooling-off period has elapsed since `request_withdrawal`. This is configurable per vault and **defaults to 0 (instant)** in the reference implementation.
2. `pending_voucher_count` is zero, meaning no tabs outstanding.

The second check is the load-bearing one. The buyer's *own passkey signature* is rejected by their *own vault* if any tab is open, and that holds with cooling-off set to 0, which is why the default is instant. Cooling-off is available as an optional delay for deployments that want one (e.g. against a compromised passkey).

---

## Verifiable claims

These claims are checkable from the public chain and the public source repo:

| Claim | Evidence |
|---|---|
| Program is deployed on Solana mainnet | Program ID `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc` |
| Buyer cannot drain mid-tab | `tests/drain-attempt.ts`, explicit adversarial test, passes |
| Buyer's own passkey gets rejected | Same test, asserts `PendingVouchersExist` error |
| Buyer cannot clear their own counter | `tests/dexter-authority.ts` asserts `settle_voucher` from any signer other than the recorded `dexter_authority` is rejected (`has_one`) |
| Buyer can always recover an abandoned tab | `tests/dexter-authority.ts` asserts `force_release` is rejected before the 7-day grace and gated to the buyer's passkey |
| Default cooling-off is 0 (instant) | `passkeyVault.ts`: `const DEFAULT_COOLING_OFF_SECONDS = 0n`; the voucher gate is the protection, not the delay |
| Session role is bounded | `swigBundle.ts:215`: `Actions.set().tokenLimit(...).programAll()` |
| WebAuthn signatures verified on-chain | `verify/webauthn.rs` via Solana's secp256r1 sysvar (`Secp256r1SigVerify1111111111111111111111111`) |

---

## Comparison to other approaches

| Approach | Where funds sit | Can buyer race the settle? | Custody |
|---|---|---|---|
| Lightning | Locked in channel funding tx | No (funds escrowed) | Non-custodial |
| Corbett Flex | Locked in channel contract | No (funds escrowed) | Non-custodial |
| x402 batch-settle (#2051) | Locked via EIP-3009 / Permit2 deposit | No (funds escrowed) | Non-custodial |
| Crossmint smart wallets | Crossmint custody | Depends on Crossmint policy | Custodial (MTL) |
| Coinbase CDP smart wallets | Custodial or self-custody | No streaming primitive | Optional custody |
| **Tab (OTS)** | **In buyer's own wallet** | **No, withdrawal path gated on-chain** | **Non-custodial, non-escrow** |

Tab is the only known shipping protocol that achieves seller-protected streaming without either custody or escrow. Funds remain in the buyer's wallet at all times.

---

## What's required of the buyer's wallet

The wallet must be a Swig smart-wallet whose root authority is bound to a Tab vault PDA. Existing Phantom/Backpack/Solflare wallets cannot retrofit Tab, because the wallet shape is part of the standard. A user with an existing wallet creates a new Tab-shaped wallet, funds it (typically via on-ramp or transfer), and uses *that* for streaming/agentic spending.

This is intentional. The on-chain enforcement only works because the program owns the relationship between the passkey, the Swig, and the withdrawal gate. A user with an arbitrary external wallet cannot opt in to OTS protections without re-creating their wallet inside the standard.

---

## Relationship to Open Wallet Standard (OWS)

[Open Wallet Standard (OWS)](https://openwallet.sh) is a local-first, multi-chain wallet and signing standard. It handles encrypted key storage, agent-API access, and pre-signing policy enforcement on the user's local machine.

Tab / OTS is the on-chain settlement complement. OWS governs *whether an agent should be allowed to sign*. OTS governs *whether the resulting funds should be releasable*. They sit at different layers and are designed to be used together.

A complete agentic-payments security model on Solana uses both: keys live in OWS, the wallet they control is a Tab-shaped Swig, and the wallet's withdrawal path is gated by an OTS-compliant vault. Two layers of defense from two independent standards.

---

## Known caveats

### 1. Replay window on `request_withdrawal`

The vault accepts a passkey assertion within a 300-second clock drift and carries no per-operation nonce, so a snooped `request_withdrawal` assertion could in principle be replayed within that window. The recommended fix, slated for v1.1, is a monotonic operation nonce bound into the signed message. This is a pre-audit finding in the reference implementation, tracked in `Dexter-DAO/dexter-vault#2`. It does not affect the core withdrawal gate: replaying the request still cannot finalize a withdrawal while a tab is open, and finalize requires its own fresh passkey signature.

### 2. Wallet-creation requirement

As noted above, OTS requires a Tab-shaped wallet. Users with existing external wallets must create a new Tab-shaped wallet. This is a UX hurdle, not a security issue, but it's worth being explicit about it in product narratives.

---

## Audit status

The vault program has not been externally audited. Funding to commission an audit is in flight as of this writing.

Self-review checklist in `Dexter-DAO/dexter-vault#1` (WebAuthn verification) and `Dexter-DAO/dexter-vault#2` (replay/nonce, saturating math) tracks pre-audit work. Code is reviewable today; the program is small (~575 lines across nine instructions plus WebAuthn verification helpers).

---

## What we'd ask reviewers to confirm

If you're a CTO at a potential partner or a serious technical reviewer, the questions worth asking are:

1. Does the `pending_voucher_count` invariant actually enforce what the spec claims it enforces? (Read `finalize_withdrawal.rs` + `tests/drain-attempt.ts`.)
2. Is the counter authority correctly bound, so only the recorded `dexter_authority` can move the gate? (Read `settle_voucher.rs` + `tests/dexter-authority.ts`.)
3. Is the WebAuthn verification correct? (Read `verify/webauthn.rs`, pending external audit.)
4. Is the replay window on `request_withdrawal` acceptable for your use case, or do you need the nonce fix landed first?
5. Is the wallet-creation requirement compatible with your user flow?

These are the right questions and we don't have anything to hide on any of them.

---

## Refs

- Program: `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc` on Solana mainnet
- Source: [`Dexter-DAO/dexter-vault`](https://github.com/Dexter-DAO/dexter-vault) (public, MIT)
- Pre-audit tracking issues: `Dexter-DAO/dexter-vault#1` (WebAuthn verification), `#2` (replay/nonce, saturating math)
- Open Wallet Standard: <https://openwallet.sh>
- x402 batch-settlement (for comparison): `x402-foundation/x402#2051`
