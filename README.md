<p align="center">
  <img src="https://raw.githubusercontent.com/Dexter-DAO/dexter-x402-sdk/main/assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">dexter-vault</h1>

<p align="center">
  <strong>The reference implementation of the Open Tabs Standard: non-custodial, non-escrow spending authorizations on Solana. Funds never leave your wallet; the program locks the exit, not the money.</strong>
</p>

<p align="center">
  <a href="https://solscan.io/account/Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc"><img src="https://img.shields.io/badge/Mainnet-Hg3wRayd…2fhc-blueviolet" alt="Mainnet program"></a>
  <img src="https://img.shields.io/badge/OTS-v1.0-orange" alt="Open Tabs Standard v1.0">
  <a href="https://www.anchor-lang.com"><img src="https://img.shields.io/badge/Anchor-0.32.1-blue" alt="Anchor"></a>
  <img src="https://img.shields.io/badge/non--custodial-passkey-brightgreen" alt="Non-custodial">
  <img src="https://img.shields.io/badge/status-LIVE-brightgreen" alt="Status: Live">
  <a href="./SECURITY.md"><img src="https://img.shields.io/badge/audit-pre--audit-yellow" alt="Pre-audit"></a>
</p>

---

## What This Is

dexter-vault is the on-chain program behind **Tab**, the reference implementation of the **Open Tabs Standard (OTS)**, a protocol for letting an agent stream payments from a user's wallet without escrow and without custody.

It inverts the standard escrow model: **instead of locking the funds, the program locks the exit path.** A buyer's USDC never moves into an escrow account, yet while any spending authorization (a "tab") is open, the buyer's own withdrawal is gated on-chain. Sellers are guaranteed payment for what the buyer authorized; buyers keep custody the whole time.

The program **does not move funds.** USDC moves out of the buyer's [Swig](https://github.com/anagram-xyz/swig) smart-wallet via the Swig program, signed by a bounded session role. dexter-vault only does the bookkeeping and gating:

- Track the number of outstanding tabs (`pending_voucher_count`), mutable only by the vault's recorded facilitator authority.
- Track a pending withdrawal intent (`pending_withdrawal`).
- Allow a withdrawal to finalize **only** when the buyer's passkey has signed it, a cooling-off window has elapsed, **and** zero tabs are outstanding.

Nine instructions, one account type, plus a WebAuthn verification module. Eight govern spending, recovery, and key rotation; the ninth, `prove_passkey`, is a read-only proof-of-control primitive — a passkey proves it owns the vault without moving funds, the basis for non-custodial sign-in and identity. The protection is on-chain, not Dexter-specific: **any facilitator that operates a session role correctly is interoperable.**

Program: **`Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`** (Solana mainnet)
Standard: [Open Tabs Standard v1.0](./docs/OTS-STANDARDS-PROPOSAL.md)

## The Problem It Solves

Agentic payments need three properties at once, and no prior standard delivers all three:

| Approach | Non-custodial | Streaming | Seller-protected |
|---|:---:|:---:|:---:|
| One-shot blockchain payment | ✓ | ✗ | ✓ |
| Lightning / payment channels | ✓ (escrow) | ✓ | ✓ |
| Custodial wallet (Crossmint, CDP) | ✗ | partial | ✓ |
| Pre-funded wallet, no gate | ✓ | ✓ | ✗ (buyer can drain) |
| **Open Tabs Standard** | **✓ (no escrow)** | **✓** | **✓** |

OTS gets all three by gating the buyer's exit instead of escrowing the buyer's funds. The closest mental model is an auth-and-capture credit-card hold, but with on-chain enforcement of the hold.

## How It Works

A buyer's Swig smart-wallet is rooted in a passkey-secured WebAuthn key and bound to a vault PDA. The vault delegates a bounded session role to a facilitator (token-spend cap, TTL, program scope, all enforced by the Swig program). The buyer spends through that role indefinitely with no per-transaction signatures, while the vault enforces one invariant on-chain:

- **Your passkey is the root authority.** Only a WebAuthn assertion from your device can initiate a withdrawal, verified on-chain via Solana's secp256r1 precompile (SIMD-0075). The facilitator never holds a key that can move your funds out.
- **The facilitator's session role is bounded.** Token-spend cap + TTL + program scope, enforced by Swig, not by trust.
- **Open tabs veto withdrawals.** `pending_voucher_count` is the load-bearing gate. While it is non-zero, `finalize_withdrawal` is rejected and the buyer's own passkey signature is insufficient. This is the mechanism that lets a seller safely extend a tab. Exercised by [`tests/drain-attempt.ts`](./tests/drain-attempt.ts), which opens a tab, confirms the mid-session drain is rejected, settles, then confirms withdrawal succeeds.
- **Only the recorded authority moves the counter.** `pending_voucher_count` is bound to the `dexter_authority` stored on the vault at creation: a transaction that touches the counter must be signed by that exact key. A buyer cannot clear their own gate to escape an open tab, and an unrelated key cannot touch it at all.
- **The buyer can always reach their funds.** If a settlement is ever abandoned and a tab is left open indefinitely, the buyer's passkey can release the stuck count itself, but only after a 7-day grace window measured from their withdrawal request. That window is the seller's guaranteed settlement period, so this is a recovery path for abandoned tabs, never an escape from active ones. Access to your money never depends on the facilitator's cooperation.

Charges *against* an open tab are off-chain signed receipts ("vouchers") that sellers verify locally; only tab open and close touch the chain. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the end-to-end flow and the off-chain receipt protocol.

## Instructions

| Instruction | Authority | Description |
|---|---|---|
| `initialize_vault` | Setup payer | Creates the `Vault` PDA, records the passkey pubkey, the facilitator authority, and the cooling-off period |
| `set_swig` | **Buyer's passkey** | Binds the vault to a Swig wallet address. **Settable exactly once**, cannot be rebound |
| `settle_voucher` | **Facilitator authority** (`has_one`) | Increments/decrements `pending_voucher_count` as tabs open and settle. Bound to the `dexter_authority` recorded at init; no other signer can move the counter |
| `request_withdrawal` | **Buyer's passkey** (secp256r1) | Records a withdrawal intent. No funds move. Requires a WebAuthn assertion verified by the secp256r1 precompile |
| `finalize_withdrawal` | **Buyer's passkey** (secp256r1) | Releases funds, **only if** `pending_voucher_count == 0` and the cooling-off has elapsed |
| `force_release` | **Buyer's passkey** (secp256r1) | Buyer's recovery path: releases a tab the facilitator never settled, but only after a 7-day grace from `request_withdrawal`. Decrements the counter only, and moves no funds |
| `rotate_passkey` | **Buyer's current passkey** | Rotates the root passkey. The current passkey must sign the new one |
| `rotate_dexter_authority` | **Current facilitator authority** | Rotates the facilitator authority. The current authority must sign the new one |
| `prove_passkey` | **Buyer's passkey** (secp256r1) | Read-only proof of control. Verifies the passkey signed a challenge (`"siwx_login" \|\| challenge`) and mutates nothing — no funds, no state, no signer. A verifier simulates `[secp256r1_verify, prove_passkey]`; `err == null` proves the passkey owns the vault. The non-custodial basis for sign-in / identity (the Solana analogue of EIP-1271) |

## The `Vault` Account

| Field | Type | Notes |
|---|---|---|
| `bump` | `u8` | PDA bump |
| `passkey_pubkey` | `[u8; 33]` | The buyer's secp256r1 (P-256) public key, the root withdrawal authority |
| `dexter_authority` | `Pubkey` | The facilitator key permitted to move `pending_voucher_count`. Recorded at init; rotatable only by itself |
| `swig_address` | `Pubkey` | The bound Swig wallet. Zero until `set_swig`; immutable after |
| `cooling_off_seconds` | `i64` | Configurable delay between `request_withdrawal` and `finalize_withdrawal` |
| `pending_voucher_count` | `u32` | Outstanding tabs. The withdrawal gate. Withdrawal blocked while > 0 |
| `pending_withdrawal` | `Option<PendingWithdrawal>` | Active withdrawal intent (amount, destination, requested-at) |
| `supabase_user_id` | `[u8; 16]` | Opaque user handle. No PII on-chain |

## Security Model

The trust boundary is deliberately narrow. **The on-chain program is authoritative:** if it disagrees with the docs, trust the program and open an issue.

- **Withdrawal gate:** funds leave only after passkey signature + zero open tabs + cooling-off elapsed. The zero-tabs check is the load-bearing one; cooling-off is configurable defense-in-depth.
- **Counter authority:** `pending_voucher_count` is bound to the vault's `dexter_authority` via `has_one`. Only that key can open or settle a tab. A buyer cannot clear their own gate, and no unrelated key can touch it.
- **Buyer recovery:** `force_release` lets the buyer's passkey reclaim a tab the facilitator abandons, after a 7-day grace. A stuck counter can never permanently freeze a buyer's funds, and the grace window keeps it from being used to escape an active tab.
- **Bound-once Swig:** `swig_address` is set exactly once and can never be rebound.
- **Bounded session role:** the facilitator's spend authority is capped, scoped, and TTL'd by the Swig program.
- **Key rotation:** both the buyer's passkey and the facilitator authority can be rotated, each signed by its current holder. No third party can rotate either.
- **No fund custody:** dexter-vault never moves money. It gates; Swig moves. No instruction, not even `force_release` or a facilitator action, can cause funds to leave without the buyer's passkey signature on `finalize_withdrawal`.

This protects the **buyer's custody and the seller's payment** without either party trusting the other. It is not a claim of perfect safety in every dimension; the trust assumptions, the known limits, and the threat model are documented in full in [`SECURITY.md`](./SECURITY.md) and the standard's threat model. **The on-chain program is authoritative.**

Audit status: **not yet externally audited** (funding in flight). Responsible disclosure: open an issue or email branch@dexter.cash.

## Build & Test

```bash
anchor build          # build the program
anchor test           # run the suite, including the adversarial drain-attempt
```

Program ID is pinned in [`Anchor.toml`](./Anchor.toml).

## Implementing OTS Yourself

dexter-vault is *a* reference implementation, not the only allowed one. The Open Tabs Standard specifies the wallet shape, instruction surface, and security properties; any program preserving them is interoperable. Other implementations, and other facilitators against this one, are encouraged. See the [standards proposal](./docs/OTS-STANDARDS-PROPOSAL.md) for the normative requirements. MIT licensed.

Dexter's own buyer-side implementation against this program lives in [`dexter-api`](https://github.com/Dexter-DAO/dexter-api) — passkey enrollment, vault provisioning, state resolution, withdrawal flows. The x402 settlement counterpart lives in [`dexter-facilitator`](https://github.com/Dexter-DAO/dexter-facilitator).

## Documentation

| Document | What it covers |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | End-to-end system design, the four-program streaming flow, off-chain receipt protocol |
| [`SECURITY.md`](./SECURITY.md) | Threat model, trust assumptions, enforced invariants, known-issue registry |
| [OTS Standards Proposal](./docs/OTS-STANDARDS-PROPOSAL.md) | The standard this implements, wallet shape, interface, security properties, adoption path |

---

<p align="center">
  <a href="https://dexter.cash">dexter.cash</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
  <a href="https://x402.org">x402.org</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
  <a href="https://twitter.com/dexteraisol">@dexteraisol</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
  <a href="https://twitter.com/BranchM">@BranchM</a>
</p>
