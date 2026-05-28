---
title: "Open Tabs Standard (OTS) v1.0: Proposal"
subtitle: "Non-custodial spending authorizations on Solana"
date: 2026-05-28
audience: Solana Foundation, x402 Foundation, OpenWallet Foundation, protocol designers
status: Draft v1
---

# Open Tabs Standard (OTS) v1.0

## Abstract

The Open Tabs Standard (OTS) defines a protocol for non-custodial, non-escrow spending authorizations on Solana. A buyer authorizes a seller (or a facilitator acting on the seller's behalf) to draw funds from the buyer's own smart-wallet over time, without the buyer's funds being moved into an escrow account or held by a custodian. Seller protection is achieved by an on-chain invariant: while any authorization (a "tab") is outstanding, the buyer's own withdrawal path is gated.

This document specifies the wallet shape, the on-chain program interface, the off-chain receipt protocol, and the security properties of OTS v1.0. A reference implementation is live on Solana mainnet at program ID `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`.

OTS is the on-chain settlement complement to the [Open Wallet Standard (OWS)](https://openwallet.sh): OWS governs local key custody and pre-signing policy, while OTS governs on-chain spending authorizations. Together they form a complete agentic-payments security model.

---

## 1. Motivation

### 1.1 Problem statement

Agentic commerce (AI agents transacting on behalf of users) requires a payments primitive with three properties that no existing standard provides simultaneously:

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

Equivalent EVM implementation requires ERC-4337 with a custom session-key validator, EIP-1271 smart-wallet verification, and an EVM passkey precompile (RIP-7212). That is possible, but not currently widespread enough for a v1.0 standard.

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
                  │ (recorded authority)   │ (passkey)
                  ▼                        ▼              decrement
            ┌──────────────┐         ┌──────────────┐    on settle
            │ Tabs: 1+      │         │ Withdrawal   │
            │ Tab is open   │         │ pending      │
            └──────┬───────┘         └──────┬───────┘
                   │                         │
                   │ settle_voucher(-1)      │ finalize_withdrawal
                   │ (recorded authority)    │ (passkey)
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

An OTS-compliant on-chain program MUST expose the following core instructions:

| Instruction | Required authority | Effect |
|---|---|---|
| `initialize_vault` | Setup payer | Create vault PDA, bind passkey pubkey, bind the facilitator authority, set cooling-off period |
| `set_swig` | Passkey assertion | Bind the buyer's Swig smart-wallet address (settable once) |
| `settle_voucher` | Recorded facilitator authority (bound at init) | Increment or decrement `pending_voucher_count` |
| `request_withdrawal` | Passkey assertion | Record withdrawal intent (no funds move) |
| `finalize_withdrawal` | Passkey assertion | Release funds; MUST require `pending_voucher_count == 0` AND `cooling_off_seconds` elapsed |

The authority for `settle_voucher` MUST be a specific key recorded on the vault at initialization, not any arbitrary signer. The counter that gates a buyer's withdrawal is security-critical: a program that lets any signer move `pending_voucher_count` lets a malicious buyer clear their own gate and drain mid-tab, which defeats the seller protection that is the entire point of the standard. The reference implementation enforces this with an Anchor `has_one = dexter_authority` constraint; any equivalent binding (the counter authority fixed at init and checked on every mutation) satisfies the requirement.

An OTS-compliant program MUST additionally provide a buyer-controlled recovery path, so that an abandoned tab can never permanently freeze the buyer's funds:

| Instruction | Required authority | Effect |
|---|---|---|
| `force_release` | Passkey assertion | Buyer clears a stuck tab the facilitator never settled, allowed only after a grace window measured from `request_withdrawal`. Decrements the counter; moves no funds |

The grace window is the seller's guaranteed settlement period: a buyer who opens this path is locked for its full duration, during which an honest seller settles normally, so `force_release` recovers abandoned tabs without becoming an escape from active ones. The reference implementation uses a 7-day grace.

A program SHOULD also provide rotation for both authorities so a vault is never permanently bound to a stale or compromised key:

| Instruction | Required authority | Effect |
|---|---|---|
| `rotate_passkey` | Buyer's current passkey | Rotate the root passkey; the current passkey signs the new one |
| `rotate_<authority>` | Current facilitator authority | Rotate the facilitator authority; the current authority signs the new one |

The vault account MUST contain at minimum:

- `passkey_pubkey: [u8; 33]`: secp256r1 compressed pubkey, the root withdrawal authority
- `<facilitator>_authority: Pubkey`: the key permitted to move `pending_voucher_count`, recorded at init
- `swig_address: Pubkey`: bound smart-wallet
- `cooling_off_seconds: i64`: minimum delay between request and finalize
- `pending_voucher_count: u32`: outstanding tabs counter, the withdrawal gate
- `pending_withdrawal: Option<PendingWithdrawal>`: recorded intent

### 2.5 Off-chain receipt protocol

Tab open and close are on-chain events. Charges *against* an open tab are off-chain signed receipts ("vouchers") with the following minimum fields:

```
{
  channel_id: string,        // unique identifier for this tab
  sequence: u64,             // monotonic, replay protection
  cumulative_amount: u64,    // total drawn so far (base units)
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

**Verification:** Adversarial test in `tests/drain-attempt.ts` (reference implementation). With one tab open (count = 1), the buyer's `request_withdrawal` succeeds in recording intent, but `finalize_withdrawal` is **REJECTED with `PendingVouchersExist`**. Only after the facilitator settles the tab (count = 0) does a second `finalize_withdrawal` succeed.

### 3.2 Buyer cannot clear their own gate

**Claim:** The buyer cannot decrement `pending_voucher_count` to escape an open tab. Only the facilitator authority recorded on the vault at initialization can move the counter.

**Mechanism:** `settle_voucher` is bound to a specific authority key stored on the vault, checked on every invocation. A transaction that touches the counter must be signed by that exact key; the buyer's passkey does not authorize it, and an unrelated key cannot touch it at all. Without this binding §3.1 is hollow: the gate would block `finalize_withdrawal`, but the buyer could simply call `settle_voucher` to zero the counter first and then withdraw. Binding the counter authority is what makes the gate load-bearing rather than cosmetic.

**Verification:** Adversarial test in `tests/dexter-authority.ts` (reference implementation) asserts that `settle_voucher` signed by a key other than the recorded authority is **REJECTED**, and that the recorded authority succeeds. The reference enforces the binding with Anchor's `has_one = dexter_authority`.

### 3.3 Buyer can always reach their funds

**Claim:** No facilitator behavior can permanently freeze a buyer's funds. If a tab is abandoned and left open indefinitely, the buyer can recover unilaterally.

**Mechanism:** `force_release` lets the buyer's passkey clear a stuck counter, but only after a grace window measured from `request_withdrawal`. The grace window is the seller's guaranteed settlement period, so an honest seller always settles first and the path only fires on genuine abandonment. It decrements the counter and moves no funds; the buyer still finalizes withdrawal with their passkey under the normal §3.1 gate. Access to funds therefore never depends on the facilitator's cooperation, while an active tab cannot be escaped because the grace window outlasts any normal settlement.

**Verification:** Tested in `tests/dexter-authority.ts` (reference implementation): `force_release` is **REJECTED** before the grace window elapses, **REJECTED** when there is no stuck voucher, and **REJECTED** for a passkey that is not the vault's buyer. These rejection paths are what prove the gate holds. The post-grace success path requires a 7-day clock and so is verified by code review rather than an automated test.

### 3.4 Facilitator cannot drain the buyer

**Claim:** The facilitator's session role is bounded. It cannot spend more than the user authorized.

**Mechanism:** The Swig session role is created with `tokenLimit(USDC, spendLimitAtomic)` and `TTL`. These are enforced by the Swig program. The facilitator cannot exceed the cap, cannot use the role after expiry, and cannot use the role for unauthorized programs.

**Verification:** Swig program's `actions.tokenSpendLimit` is checked on every spending transaction. Reference implementation verifies the role at session-open time: `swigAdapter.ts:186`.

### 3.5 Cooling-off is optional defense in depth

**Claim:** A configurable delay between `request_withdrawal` and `finalize_withdrawal` is available as an extra layer, but it is **not** the mechanism that protects sellers. The `pending_voucher_count` gate (§3.1) is, and it is enforced independently.

**Mechanism:** `finalize_withdrawal` enforces two requirements separately: `pending_voucher_count == 0` AND `now - requested_at >= cooling_off_seconds`. The counter check is load-bearing; the cooling-off check is supplementary. `cooling_off_seconds` is set per vault at initialization and **defaults to 0 (instant) in the reference implementation**, because the voucher gate alone blocks the only drain it needs to (mid-tab exit), which the adversarial test in §3.1 proves with cooling-off set to 0. A non-zero cooling-off remains available for deployments that want an additional delay (e.g. against a compromised passkey), at the cost of withdrawal latency.

### 3.6 Passkey signatures are verified on-chain

**Claim:** All passkey-gated operations (`set_swig`, `request_withdrawal`, `finalize_withdrawal`, `force_release`, `rotate_passkey`) verify a WebAuthn assertion on-chain via Solana's secp256r1 precompile.

**Mechanism:** `verify/webauthn.rs` reconstructs the signed digest as `sha256(authenticatorData || sha256(clientDataJSON))`, parses the `clientDataJSON` to extract the challenge, and verifies that the challenge equals `sha256(operation_message)`. The signature itself is verified by the `Secp256r1SigVerify1111111111111111111111111` precompile.

**Verification:** Subject to external audit (pending). Pre-audit self-review tracked in `Dexter-DAO/dexter-vault#1`.

---

## 4. Relationship to existing standards

### 4.1 OWS: Open Wallet Standard

[OWS](https://openwallet.sh) defines a local-first, multi-chain wallet vault with policy-gated signing. It addresses:

- Encrypted local key storage
- Policy enforcement before signing
- Multi-chain key derivation
- Agent-API authentication

OWS is **complementary** to OTS:

- OWS asks "should this agent be allowed to *sign*?"
- OTS asks "should this signature *release funds*?"

A complete agentic-payments security stack uses both. Keys live in OWS, and the wallet they control is an OTS-compliant Tab. Spending governance happens at two independently administered layers: local policy (OWS) and on-chain settlement (OTS).

We recommend OWS implementations include first-class support for OTS-compliant wallets, and OTS-compliant facilitators accept OWS-signed assertions transparently.

### 4.2 x402: HTTP-402 Payments Protocol

[x402](https://github.com/x402-foundation/x402) defines an HTTP-level payments protocol with multiple scheme implementations: `exact` (one-shot), `upto` (Permit2-based partial), and `batch-settlement` (channel-based streaming via on-chain escrow).

OTS is **complementary** and could be exposed as an additional x402 scheme: `tab` (or `ots`). Doing so would let any x402-compliant client transparently pay OTS-protected services without protocol-specific code. We intend to propose a `tab` scheme to the x402 Foundation.

### 4.3 Swig

The reference implementation uses the [Swig smart-wallet program](https://github.com/anagram-xyz/swig) for the session-role primitive. Other implementations MAY use different smart-wallet programs that provide equivalent scoped-authority delegation.

### 4.4 Lightning / payment channels

Lightning is the prior art for streaming non-custodial payments. OTS differs in two material ways:

1. **No funds in escrow.** Lightning channels require both sides to lock capital. OTS does not.
2. **Single-sided commitment.** Lightning channels require both parties online and cooperating. OTS only requires the seller's facilitator to be online; the buyer is offline most of the time.

OTS is closer in spirit to a hotel hold or auth-and-capture credit card flow than to a Lightning channel, but with on-chain enforcement of the hold semantics.

---

## 5. Threat model

### 5.1 Trust assumptions

- **Trusted:** Solana's consensus and runtime. The vault program after audit. The Swig program. The WebAuthn precompile.
- **Untrusted:** The buyer (may attempt to drain). The seller (may attempt to over-claim). The facilitator (may attempt to inflate or replay claims). The network between buyer/seller/facilitator (may attempt MITM).

### 5.2 Attacks and mitigations

| Attack | Mitigation |
|---|---|
| Buyer drains wallet mid-tab | `pending_voucher_count > 0` blocks `finalize_withdrawal` |
| Buyer clears their own gate | `settle_voucher` bound to the recorded facilitator authority; the buyer's key cannot move the counter |
| Buyer drains via different program | Swig wallet enforces program allowlist on session role |
| Facilitator over-charges | Session role's `tokenLimit` caps total spend at chain level |
| Facilitator replays old voucher | Voucher `sequence` is monotonic; sellers reject stale |
| Seller forges voucher | Vouchers signed by facilitator session key, not seller |
| Facilitator abandons a tab to freeze buyer funds | `force_release` lets the buyer's passkey clear the stuck counter after the grace window; funds are never permanently frozen |
| Compromised passkey | Standard WebAuthn assumptions apply (hardware-backed, biometric-gated); `rotate_passkey` retires a suspected-compromised key |
| Stale or compromised facilitator authority | `rotate_<authority>` retires it; signed by the current authority |
| Buyer drains via withdrawal racing | Blocked by the `pending_voucher_count` gate regardless of cooling-off; an optional configurable cooling-off delay adds defense in depth (default 0) |
| Tab-counter overflow | Reference uses `saturating_add` (capped at u32::MAX); audit issue tracked |

### 5.3 Implementation requirements and open issues

**Tab open MUST confirm before vouchers issue.** A facilitator MUST NOT issue vouchers against a tab until that tab's on-chain increment has confirmed. Opening a session optimistically (issuing vouchers while the increment is still in flight) creates a window in which the buyer's gate reads zero and a withdrawal could race the increment. Implementations MUST either block session-open on confirmation or gate voucher issuance on the observed on-chain count. The reference implementation blocks session-open on the confirmed increment.

**Open pre-audit issue, replay window on `request_withdrawal`** (`Dexter-DAO/dexter-vault#2`). The reference implementation accepts a passkey assertion within a 300-second clock drift and carries no per-operation nonce, so a snooped assertion can in principle be replayed within that window. The recommended fix, slated for v1.1, is a monotonic operation nonce bound into the signed message. This is a pre-audit finding in the reference implementation, documented here for transparency; it is not a flaw in the core gating mechanism.

---

## 6. Reference implementation

The Dexter Tab reference implementation is live on Solana mainnet:

| Component | Location |
|---|---|
| Vault program | `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc` |
| Source repo | [`Dexter-DAO/dexter-vault`](https://github.com/Dexter-DAO/dexter-vault) (public, MIT) |
| Facilitator | `Dexter-DAO/dexter-facilitator` (private, access on request) |
| Mid-tab drain test | `dexter-vault/tests/drain-attempt.ts` |
| Counter-authority + recovery gating | `dexter-vault/tests/dexter-authority.ts` |
| Withdrawal flow (cooling-off, zero-tabs gate) | `dexter-vault/tests/withdrawal-flow.ts` |
| Voucher counter round-trip | `dexter-vault/tests/settle-voucher.ts` |
| Authority + passkey rotation | `dexter-vault/tests/rotation.ts` |
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

We propose `tab` as a new scheme in the x402 protocol. Integration would let any x402 client pay OTS-protected services transparently.

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

4. **Cooling-off range.** The reference implementation defaults to 0 (the voucher gate is the real protection) but allows any per-vault value. Should the spec define a recommended range for deployments that opt into a delay, or leave it fully configurable?

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
