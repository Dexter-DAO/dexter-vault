<p align="center">
  <img src="https://raw.githubusercontent.com/Dexter-DAO/dexter-x402-sdk/main/assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">dexter-vault</h1>

<p align="center">
  <strong>The non-custodial withdrawal gate for the Open Tabs Standard. A Solana program that lets agents stream micropayments from your wallet while making it impossible for anyone — including Dexter — to drain it.</strong>
</p>

<p align="center">
  <a href="https://solscan.io/account/Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc"><img src="https://img.shields.io/badge/Mainnet-Hg3wRayd…2fhc-blueviolet" alt="Mainnet program"></a>
  <a href="https://www.anchor-lang.com"><img src="https://img.shields.io/badge/Anchor-0.32.1-blue" alt="Anchor"></a>
  <img src="https://img.shields.io/badge/non--custodial-passkey-brightgreen" alt="Non-custodial">
  <img src="https://img.shields.io/badge/status-LIVE-brightgreen" alt="Status: Live">
  <a href="./SECURITY.md"><img src="https://img.shields.io/badge/audit-pre--audit-yellow" alt="Pre-audit"></a>
</p>

---

## What This Is

dexter-vault is one Anchor program, one account type (`Vault`), and five instructions. Its job is to **gate withdrawals** from a buyer's [Swig](https://swig.so) smart-wallet so the buyer cannot drain the wallet while spending authorizations ("tabs") are still open.

The program **does not move funds.** USDC moves out of the buyer's Swig wallet via the Swig program, signed by a capped, time-limited session role that Dexter operates. dexter-vault only does the bookkeeping and gating:

- Track the number of outstanding tabs (`pending_voucher_count`).
- Track a pending withdrawal intent (`pending_withdrawal`).
- Allow a withdrawal to finalize **only** when the buyer's passkey has signed it, a cooling-off window has elapsed, **and** zero tabs are outstanding.

It is ~250 lines of Rust across five instructions plus a WebAuthn verification module. Small on purpose: a withdrawal gate is only as trustworthy as it is reviewable, so the program keeps its surface area minimal and its invariants few.

Program: **`Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc`** (Solana mainnet)

## Why It Exists

Streaming agent payments have a hard problem: the agent needs standing authorization to spend, but standing authorization is exactly what lets a compromised or rogue counterparty drain a wallet. dexter-vault resolves it with a **passkey-rooted, counter-gated** model:

- **Your passkey is the root authority.** Only a WebAuthn assertion from your device can initiate a withdrawal. Dexter never holds a key that can move your funds out of the wallet.
- **Dexter's session role is bounded.** Granted at onboarding with a `tokenLimit`, `programAll` scope, and a TTL — enforced by the Swig program, not by trust.
- **Open tabs veto withdrawals.** `pending_voucher_count` is the load-bearing gate. While it is non-zero, a withdrawal cannot finalize — this is what protects against the rogue-buyer drain, and it is proven by [`tests/drain-attempt.ts`](./tests/) (which sets cooling-off to 0 and is still blocked).

This is the on-chain enforcement behind Dexter's non-custodial wallet — see [`SECURITY.md`](./SECURITY.md) for the full threat model and [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the end-to-end flow.

## Instructions

| Instruction | Authority | Description |
|---|---|---|
| `initialize_vault` | Fee payer (Dexter) | Creates the `Vault` PDA for a user, records the passkey pubkey and cooling-off period |
| `set_swig` | Fee payer (Dexter) | Binds the vault to a Swig wallet address. **Settable exactly once** — cannot be rebound |
| `settle_voucher` | Dexter session signer | Decrements `pending_voucher_count` when a tab settles on-chain (kept honest adjacent to the USDC transfer) |
| `request_withdrawal` | **Buyer's passkey** (secp256r1) | Records a withdrawal intent. Requires a valid WebAuthn assertion verified via the Solana secp256r1 precompile |
| `finalize_withdrawal` | **Buyer's passkey** (secp256r1) | Executes the withdrawal — **only if** `pending_voucher_count == 0` and the cooling-off has elapsed |

## The `Vault` Account

| Field | Type | Notes |
|---|---|---|
| `bump` | `u8` | PDA bump |
| `passkey_pubkey` | `[u8; 33]` | The buyer's secp256r1 (P-256) public key — the root withdrawal authority |
| `swig_address` | `Pubkey` | The bound Swig wallet. Zero until `set_swig`; immutable after |
| `cooling_off_seconds` | `i64` | Delay between `request_withdrawal` and `finalize_withdrawal` |
| `pending_voucher_count` | `u32` | Outstanding tabs. The withdrawal gate. Withdrawal blocked while > 0 |
| `pending_withdrawal` | `Option<PendingWithdrawal>` | Active withdrawal intent (amount, destination, requested-at) |
| `supabase_user_id` | `[u8; 16]` | Opaque user handle. No PII on-chain |

## Security Model

The trust boundary is deliberately narrow. **The on-chain program is authoritative** — if it disagrees with the docs, trust the program and open an issue.

- **Withdrawal gate:** funds leave only after passkey signature + cooling-off + zero open tabs.
- **Bound-once Swig:** `swig_address` is set exactly once and can never be rebound.
- **Bounded session role:** Dexter's spend authority is capped and TTL'd by the Swig program.
- **No fund custody:** dexter-vault never moves money. It gates; Swig moves.

Audit status: **not yet externally audited** (funding in flight). Full threat model, trust assumptions, and known-issue registry in [`SECURITY.md`](./SECURITY.md). Responsible disclosure: open an issue or email branch@dexter.cash.

## Build & Test

```bash
# Build the program
anchor build

# Run the test suite (includes the adversarial drain-attempt)
anchor test
```

Mainnet deploys use the upgrade authority at `~/.config/solana/dexter-vault/upgrade-authority.json`. Program ID is pinned in [`Anchor.toml`](./Anchor.toml).

## Documentation

| Document | What it covers |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | End-to-end system design, the four-program streaming flow, integration reference |
| [`SECURITY.md`](./SECURITY.md) | Threat model, trust assumptions, enforced invariants, known-issue registry |

---

<p align="center">
  <a href="https://dexter.cash">dexter.cash</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
  <a href="https://x402.org">x402.org</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
  <a href="https://twitter.com/dexteraisol">@dexteraisol</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
  <a href="https://twitter.com/BranchM">@BranchM</a>
</p>
