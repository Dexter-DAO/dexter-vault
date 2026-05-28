---
title: "Open Tabs Standard (OTS) v1.0 — Proposal"
subtitle: "Non-custodial spending authorizations on Solana"
date: 2026-05-10
audience: Solana Foundation, x402 Foundation, OpenWallet Foundation, protocol designers
status: Draft v1
---

# Open Tabs Standard (OTS) v1.0

## Abstract

The Open Tabs Standard (OTS) defines a protocol for non-custodial, non-escrow spending authorizations on Solana. A buyer authorizes a seller (or a facilitator acting on the seller's behalf) to draw funds from the buyer's own smart-wallet over time, without the buyer's funds being moved into an escrow account or held by a custodian. Seller protection is achieved by an on-chain invariant: while any authorization (a "tab") is outstanding, the buyer's own withdrawal path is gated.

This document specifies the wallet shape, the on-chain program interface, the off-chain receipt protocol, and the security properties of OTS v1.0. A reference implementation is live on Solana mainnet at program ID `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`.

OTS is the on-chain settlement complement to the [Open Wallet Standard (OWS)](https://openwallet.sh). OWS governs local key custody and pre-signing policy. OTS governs on-chain spending authorizations. Together they form a complete agentic-payments security model.

---

## 1. Motivation

### 1.1 Problem statement

Agentic commerce — AI agents transacting on behalf of users — requires a payments primitive with three properties that no existing standard provides simultaneously:

- **Non-custodial.** The user's funds must not be held by a third party. (Required for compliance, capital efficiency, and trust.)
- **Streaming / deferred.** The user must be able to authorize spending once and have the agent draw against that authorization many times without per-transaction friction. (Required for usability at agent speeds.)
- **Seller-protected.** The seller must be guaranteed payment for spending the user authorized. (Required for any seller to accept the payment method.)

Today's options each sacrifice one of the three:

| Approach | Non-custodial | Streaming | Seller-protected |
|---|---|---|---|
| One-shot blockchain payment | ✓ | ✗ | ✓ |
| Lightning / channels | ✓ (with escrow) | ✓ | ✓ |
| Custodial wallet (Crossmint, Coinbase CDP) | ✗ | partial | ✓ |
| Pre-funded wallet (no gate) | ✓ | ✓ | ✗ (buyer can drain) |
| x402 batch-settlement (escrow) | ✓ (with escrow) | ✓ | ✓ |
| **OTS** | **✓ (no escrow)** | **✓** | **✓** |

OTS achieves all three by inverting the standard escrow model: instead of locking the funds, the program locks the buyer's exit path.

### 1.2 Why this is buildable on Solana now

Three Solana-specific primitives enable OTS:

1. **secp256r1 sysvar** (`Secp256r1SigVerify1111111111111111111111111`). Allows native on-chain verification of WebAuthn/passkey signatures.
2. **Swig smart-wallet program**. Native scoped-authority delegation with token-spend limits, TTL, and program allowlists.
3. **Sub-second finality at sub-cent fees**. Makes tab open/close transactions economically viable.

Equivalent EVM implementation requires ERC-4337 with a custom session-key validator, EIP-1271 smart-wallet verification, and an EVM passkey precompile (RIP-7212) — possible but not currently widespread enough for a v1.0 standard.

---

## 2. Protocol overview

### 2.1 Actors

- **Buyer.** The end user with funds. Controls a passkey-secured Swig smart-wallet bound to an OTS vault.
- **Seller.** A service provider accepting OTS payments (an API, a content provider, an agent service).
- **Facilitator.** A service that operates the seller's session key, accepts and verifies off-chain receipts, and broadcasts settlement to chain. May be the seller themselves or a third party (e.g. Dexter).

### 2.2 Wallet shape

An OTS-compliant wallet has four required properties:

1. **Root authority is a WebAuthn-verifiable key** (secp256r1 / P-256).
2. **Root authority is bound to an on-chain vault PDA** that gates withdrawal.
3. **Spending is delegated to a session role** with bounded permissions (token spend limit, TTL, program scope).
4. **Withdrawal path requires both a passkey signature AND a zero-tabs precondition.**

The reference implementation uses the Swig smart-wallet program for (3) and a custom Anchor program for (1, 2, 4). Other implementations MAY use different underlying primitives provided they preserve these four properties.

### 2.3 State machine

```
                    ┌─────────────────┐
                    │  Vault initialized │
                    │  (passkey bound)   │
                    └────────┬──────────┘
                             │ set_swig (passkey)
                             ▼
                    ┌─────────────────┐
                    │  Vault armed     │
                    │  (Swig bound)    │
                    └────────┬──────────┘
                             │ session role granted (passkey + Swig)
                             ▼
            ┌────────────────────────────────────────┐
            │                                         │
            │            Tabs:  0                     │◄─────┐
            │                                         │      │
            └─────┬────────────────────────┬──────────┘      │
                  │ settle_voucher(+1)     │ request_withdrawal
                  │ (session signer)       │ (passkey)
                  ▼                        ▼              decrement
            ┌──────────────┐         ┌──────────────┐    on settle
            │ Tabs: 1+      │         │ Withdrawal   │
            │ Tab is open   │         │ pending      │
            └──────┬───────┘         └──────┬───────┘
                   │                         │
                   │ settle_voucher(-1)      │ finalize_withdrawal
                   │ (session signer)        │ (passkey)
                   │                         │ REJECTED if Tabs > 0
                   ▼                         ▼
            ┌──────────────┐         ┌──────────────┐
            │ Tabs: 0       │         │ Funds        │
            │ (or lower)    │         │ released     │
            └───────────────┘         │ (only if tabs = 0
                                      │  AND cooling-off ≥ N) │
                                      └──────────────┘
```

### 2.4 On-chain program interface

An OTS-compliant on-chain program MUST expose the following instructions:

| Instruction | Required authority | Effect |
|---|---|---|
| `initialize_vault` | Setup payer | Create vault PDA, bind passkey pubkey, set cooling-off period |
| `set_swig` | Passkey assertion | Bind the buyer's Swig smart-wallet address |
| `settle_voucher` | Facilitator session signer | Increment or decrement `pending_voucher_count` |
| `request_withdrawal` | Passkey assertion | Record withdrawal intent (no funds move) |
| `finalize_withdrawal` | Passkey assertion | Release funds — MUST require `pending_voucher_count == 0` AND `cooling_off_seconds` elapsed |

The vault account MUST contain at minimum:

- `passkey_pubkey: [u8; 33]` — secp256r1 compressed pubkey
- `swig_address: Pubkey` — bound smart-wallet
- `cooling_off_seconds: i64` — minimum delay between request and finalize
- `pending_voucher_count: u32` — outstanding tabs counter
- `pending_withdrawal: Option<PendingWithdrawal>` — recorded intent

### 2.5 Off-chain receipt protocol

Tab open and close are on-chain events. Charges *against* an open tab are off-chain signed receipts ("vouchers") with the following minimum fields:

```
{
  channel_id: string,        // unique identifier for this tab
  sequence: u64,             // monotonic, replay protection
  cumulative_amount: u64,    // total drawn so far (atomic units)
  expires_at: i64,           // unix timestamp
  signature: bytes,          // signed by facilitator session key
}
```

Sellers verify vouchers locally (microsecond latency, no chain calls). At tab close, the cumulative amount is settled in a single on-chain transaction that also decrements the voucher counter.

---

## 3. Security properties

### 3.1 Buyer cannot grief mid-tab

**Claim:** While any tab is open, the buyer cannot withdraw funds from the bound Swig wallet.

**Mechanism:** `finalize_withdrawal` requires `pending_voucher_count == 0`. The check is enforced by the on-chain program, not by the facilitator. The buyer's own passkey signature is insufficient.

**Verification:** Adversarial test in `tests/drain-attempt.ts` (reference implementation). Test asserts:
1. Open tab (count = 1).
2. Buyer signs `request_withdrawal` — succeeds (records intent).
3. Buyer signs `finalize_withdrawal` — **REJECTED with `PendingVouchersExist`**.
4. Facilitator settles tab (count = 0).
5. Buyer signs `finalize_withdrawal` — succeeds.

### 3.2 Facilitator cannot drain the buyer

**Claim:** The facilitator's session role is bounded — it cannot spend more than the user authorized.

**Mechanism:** The Swig session role is created with `tokenLimit(USDC, spendLimitAtomic)` and `TTL`. These are enforced by the Swig program. The facilitator cannot exceed the cap, cannot use the role after expiry, and cannot use the role for unauthorized programs.

**Verification:** Swig program's `actions.tokenSpendLimit` is checked on every spending transaction. Reference implementation verifies the role at session-open time: `swigAdapter.ts:186`.

### 3.3 Cooling-off provides defense in depth

**Claim:** Even if a buyer somehow bypasses the `pending_voucher_count` check, a 24-hour delay between `request_withdrawal` and `finalize_withdrawal` makes drain-racing impractical for streaming use cases.

**Mechanism:** `finalize_withdrawal` checks `now - requested_at >= cooling_off_seconds`. Default cooling-off is 24 hours (`86_400` seconds). Configurable per vault at initialization.

### 3.4 Passkey signatures are verified on-chain

**Claim:** All passkey-gated operations (`set_swig`, `request_withdrawal`, `finalize_withdrawal`) verify a WebAuthn assertion on-chain via Solana's secp256r1 precompile.

**Mechanism:** `verify/webauthn.rs` reconstructs the signed digest as `sha256(authenticatorData || sha256(clientDataJSON))`, parses the `clientDataJSON` to extract the challenge, and verifies that the challenge equals `sha256(operation_message)`. The signature itself is verified by the `Secp256r1SigVerify1111111111111111111111111` precompile.

**Verification:** Subject to external audit (pending). Pre-audit self-review tracked in `Dexter-DAO/dexter-vault#1`.

---

## 4. Relationship to existing standards

### 4.1 OWS — Open Wallet Standard

[OWS](https://openwallet.sh) defines a local-first, multi-chain wallet vault with policy-gated signing. It addresses:

- Encrypted local key storage
- Policy enforcement before signing
- Multi-chain key derivation
- Agent-API authentication

OWS is **complementary** to OTS:

- OWS asks "should this agent be allowed to *sign*?"
- OTS asks "should this signature *release funds*?"

A complete agentic-payments security stack uses both. Keys live in OWS. The wallet they control is an OTS-compliant Tab. Spending governance happens at two layers — local policy (OWS) and on-chain settlement (OTS) — independently administered.

We recommend OWS implementations include first-class support for OTS-compliant wallets, and OTS-compliant facilitators accept OWS-signed assertions transparently.

### 4.2 x402 — HTTP-402 Payments Protocol

[x402](https://github.com/x402-foundation/x402) defines an HTTP-level payments protocol with multiple scheme implementations: `exact` (one-shot), `upto` (Permit2-based partial), and `batch-settlement` (channel-based streaming via on-chain escrow).

OTS is **complementary** and could be exposed as an additional x402 scheme: `tab` (or `ots`). Doing so would let any x402-compliant client transparently pay OTS-protected services without protocol-specific code. We intend to propose a `tab` scheme in the x402 v2.13 cycle.

### 4.3 Swig

The reference implementation uses the [Swig smart-wallet program](https://github.com/anagram-xyz/swig) for the session-role primitive. Other implementations MAY use different smart-wallet programs that provide equivalent scoped-authority delegation.

### 4.4 Lightning / payment channels

Lightning is the prior art for streaming non-custodial payments. OTS differs in two material ways:

1. **No funds in escrow.** Lightning channels require both sides to lock capital. OTS does not.
2. **Single-sided commitment.** Lightning channels require both parties online and cooperating. OTS only requires the seller's facilitator to be online; the buyer is offline most of the time.

OTS is closer in spirit to a hotel hold or auth-and-capture credit card flow than to a Lightning channel — but with on-chain enforcement of the hold semantics.

---

## 5. Threat model

### 5.1 Trust assumptions

- **Trusted:** Solana's consensus and runtime. The vault program after audit. The Swig program. The WebAuthn precompile.
- **Untrusted:** The buyer (may attempt to drain). The seller (may attempt to over-claim). The facilitator (may attempt to inflate or replay claims). The network between buyer/seller/facilitator (may attempt MITM).

### 5.2 Attacks and mitigations

| Attack | Mitigation |
|---|---|
| Buyer drains wallet mid-tab | `pending_voucher_count > 0` blocks `finalize_withdrawal` |
| Buyer drains via different program | Swig wallet enforces program allowlist on session role |
| Facilitator over-charges | Session role's `tokenLimit` caps total spend at chain level |
| Facilitator replays old voucher | Voucher `sequence` is monotonic; sellers reject stale |
| Seller forges voucher | Vouchers signed by facilitator session key, not seller |
| Compromised passkey | Standard WebAuthn assumptions apply (hardware-backed, biometric-gated) |
| Cooling-off races | 24-hour default delay; configurable |
| Tab-counter overflow | Reference uses `saturating_add` (capped at u32::MAX) — audit issue tracked |

### 5.3 Known open issues

The reference implementation has two acknowledged caveats:

1. **Fire-and-forget increment race** at session-open (`Dexter-DAO/dexter-facilitator#45`). A session can open before its on-chain increment confirms; mitigation is to make session-open block on confirmation or to gate voucher issuance on observed on-chain count.

2. **Replay window on `request_withdrawal`** (`Dexter-DAO/dexter-vault#2`). The 300-second drift on the passkey assertion combined with no operation nonce means a snooped assertion can be replayed within that window. Recommend including a monotonic nonce in v1.1.

These are integration-layer and pre-audit findings, not flaws in the core mechanism. They are documented here for transparency.

---

## 6. Reference implementation

The Dexter Tab reference implementation is live on Solana mainnet:

| Component | Location |
|---|---|
| Vault program | `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc` |
| Source repo | [`Dexter-DAO/dexter-vault`](https://github.com/Dexter-DAO/dexter-vault) (public, MIT) |
| Facilitator | `Dexter-DAO/dexter-facilitator` (private — access on request) |
| Adversarial tests | `dexter-vault/tests/drain-attempt.ts` |
| Real-world traffic | Mainnet USDC payments settling today |

The reference implementation is published under MIT license. Other implementations of OTS are encouraged.

---

## 7. Adoption path

### 7.1 Solana Foundation

We propose OTS as a Solana standards-track document. Specifically:

- Submission as a Solana Improvement Document (SIMD or equivalent) for the spec itself.
- Inclusion in the Foundation's agentic-payments ecosystem positioning.
- Reference implementation by Dexter; second/third implementations welcomed.

### 7.2 x402 Foundation

We propose `tab` as a v2.13 scheme in the x402 protocol. Integration would let any x402 client pay OTS-protected services transparently.

### 7.3 OWS / OpenWallet Foundation

We propose joint documentation with OWS describing the OWS+OTS integration. Specifically: OWS implementations that support OTS-compliant Tab wallets, and OTS facilitators that accept OWS-signed assertions.

### 7.4 Wallet implementers

Phantom, Backpack, Solflare, Squads, and any wallet team interested in supporting agentic streaming payments are invited to ship an OTS-compliant Tab. The on-chain primitive does not require Dexter's facilitator; any facilitator that operates a session role correctly is interoperable.

### 7.5 Facilitator implementers

Coinbase, Crossmint, MoonPay, x402 Foundation facilitators, and independents are invited to operate OTS facilitators. Sellers benefit from facilitator competition; the on-chain protocol provides protection regardless of which facilitator is in use.

---

## 8. Open questions for the community

The following are deliberately left open for the v1.0 review period:

1. **Voucher format.** Should the off-chain voucher schema be normatively specified, or left to facilitator/client negotiation? Trade-off: standardization enables ecosystem interop, but premature standardization constrains experimentation.

2. **Multiple concurrent tabs.** The reference implementation supports multiple concurrent tabs against one vault (the counter increments per tab). Should the spec require multi-tab support, or leave it optional?

3. **Refunds.** OTS v1.0 supports refunds via facilitator-initiated `settle_voucher(decrement)` without settlement. Should refund semantics be more formally specified?

4. **Cooling-off range.** Default is 24 hours. Should the spec define a minimum (e.g. 1 hour) and maximum (e.g. 30 days)? Or leave fully configurable?

5. **Multi-chain.** OTS v1.0 is Solana-only. Should v1.1 include a parallel EVM specification (ERC-4337 + custom validator + RIP-7212), or should EVM-OTS be a separate parallel standard?

---

## 9. Acknowledgements

OTS draws on prior work in payment channels (Lightning), session-key wallets (Swig, ERC-7579), passkey-secured authority (WebAuthn / FIDO2), and HTTP-402 payments (x402, MPP). The combination of these primitives into a non-custodial, non-escrow streaming standard is, to our knowledge, novel.

---

## 10. References

- Reference implementation: `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc` (Solana mainnet)
- OWS (Open Wallet Standard): <https://openwallet.sh>
- x402 protocol: <https://github.com/x402-foundation/x402>
- Swig smart-wallet program: <https://github.com/anagram-xyz/swig>
- WebAuthn / FIDO2 specification: <https://www.w3.org/TR/webauthn-2/>
- Solana secp256r1 precompile: `Secp256r1SigVerify1111111111111111111111111`
- Companion technical brief: [`OTS-TECHNICAL-BRIEF.md`](./OTS-TECHNICAL-BRIEF.md) (this folder)
