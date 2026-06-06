# Credit Level 2 — External-Financier Standby Credit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent spend PAST the user's own vault balance, with the gap covered in real time by an external financier's standby capital — the financier's funds drawn directly from THEIR own vault (never escrowed), the user's collateral pinned until repayment, and the financier able to seize the borrowed amount from that pinned collateral after a deadline if the buyer abandons. This is real credit (the buyer goes negative), non-custodial on both sides.

**Architecture:** New on-chain program instructions + a V4→V5 Vault migration. The financier signs a STANDING pre-authorization ("back vault X up to $N") once; the chain enforces the bounds on every draw (no per-draw co-sign — agent-speed). A draw is a swig-authorized cross-vault transfer from the FINANCIER's vault straight to the seller (Option A — financier custody, no pool account), mirroring the proven `settle_locked_voucher` two-instruction SignV2 shape. The user's collateral is soft-pinned (slice-only): the existing `finalize_withdrawal` reservation guard family is extended to count `borrowed` against withdrawable balance. Repayment draws the borrowed slice down first as micro-payments clear. Liquidation on default is the MIRROR of the already-shipped `recover_abandoned_lock` (deadline check → re-credit accumulator → status flip), pointed financier-ward. NO new escrow, NO pooled funds — the non-custodial property holds end to end.

**Tech Stack:** Rust / Anchor 0.32.1 (`cargo-build-sbf 3.1.14`), the dexter-vault program at `Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc` (currently 19 instructions, Vault V4). SDK: TypeScript `@dexterai/vault`. Tests: `ts-mocha` on mainnet (secp256r1 precompile is mainnet-only) via Helius RPC. Deploy: `solana program extend` + `solana program deploy` (the ~3 SOL transient-buffer two-step, documented in PICKUP-2026-06-06).

---

## Current on-chain ground truth (verified 2026-06-07)

- **Vault is V4.** Versions: `VAULT_VERSION_V2/V3/V4` in `state.rs`. V4 added the 3 LockedClaim accumulators (`outstanding_locked_amount`, `total_crystallized_amount`, `total_settled_amount`). Plan adds **V5**.
- **SessionRegistration** (inside `vault.active_session`) has: `max_amount`, `spent`, `current_outstanding`, `max_revolving_capacity`, `crystallized_cumulative`, `last_locked_sequence`. The credit draw interacts with the revolving meter: a draw is spend that exceeds the user's balance but stays within the financier-backed ceiling.
- **Migration template:** `migrate_v3_to_v4.rs` — decode-old-as-frozen-struct / re-encode-as-current (NOT append-zero-fill, because V4 has an interior growth point). V5 follows the SAME decode/re-encode strategy with hand-frozen `VaultV4`/`SessionRegistrationV4` snapshots. (migrate_v2_to_v3 + migrate_v3_to_v4 both exist as references.)
- **Swig-authorized transfer model:** `settle_locked_voucher.rs` header documents the canonical two-ix atomic shape — `[N] vault::<ix>` then `[N+1] swig::SignV2(TransferChecked)`, where Swig validates `accounts[0..1] == [swig, swig_wallet]` and the preceding ix's discriminator is a registered ProgramExec marker. The credit DRAW uses this exact shape, but the swig is the FINANCIER's swig (their vault funds the transfer).
- **Liquidation mirror:** `recover_abandoned_lock.rs` handler = `now >= holder_recovery_at` (ForceReleaseTooEarly else) → passkey-verify op-message `"..." || vault || claim` → `outstanding_locked_amount.saturating_sub(claim.amount)` → status Pending→Abandoned, `recovered_at = now`. Credit liquidation is this, pointed at the financier reclaiming the borrowed slice.
- **Errors** live in `state.rs` `VaultError` (`#[error_code]`): existing `LockWouldOvercommitVault` (6016), `WithdrawalWouldViolateReservation`, `SessionWouldOvercommitVault`, `PendingVouchersExist`, `ForceReleaseTooEarly`, `NothingToRelease`. New credit errors append here.
- **Anti-rug guards already proven** (Phase 1): the credit guards extend the same patterns — never authorize/draw past available backing; never withdraw below pinned.

---

## Design decisions (LOCKED in the Ε design-lock + this session)

- **Custody: Option A.** Financier capital stays in the financier's OWN dexter-vault. A draw moves USDC from the financier's vault directly to the seller at clearing time. No pool account, no escrow. Credit is as non-custodial as factoring.
- **Authorization: standing pre-authorization.** The financier signs the backing policy once (`open_standby` below). The chain enforces bounds on every draw; no per-draw financier signature. This is constitutive — per-draw co-sign would destroy agent-speed credit.
- **Pin: soft, slice-only.** Only the borrowed amount (+ a buffer) is pinned, not the whole user balance; the user can repay-to-unlock. Enforced by extending the withdrawal-reservation guard to include `borrowed`.
- **Liquidation: deadline-seize, mirror of recover_abandoned_lock.** After a deadline, the financier can reclaim the borrowed slice from the user's pinned collateral.
- **Spread/fee = operator policy** (lives in the consumer, like the withdrawal fee + the factoring spread). Not hardcoded in the program.
- **Buyer-protection = Ζ-gated, DELIBERATELY out of v1.** `open_standby` lets the financier set `standby_cap` and `recovery_window_seconds`. In v1 (the demo) Branch controls BOTH sides, so there is no adversarial financier — sane values are chosen by hand. But in a real two-sided market (Ζ), these two financier-set numbers are **buyer-protection surfaces**: a predatory financier could set a trap-short `recovery_window_seconds` (deadline passes before the buyer's auto-repay can clear → premature seizure) or abusive cap/terms. The anti-rug guards in this plan protect the FINANCIER from the buyer (cap, pin, no-early-seize); the MIRROR protection (buyer from a predatory financier — minimum recovery windows, buyer consent to cap/terms, max effective rate) is a Ζ-scope layer and is **intentionally NOT built here.** This is a documented deferral, not an oversight: building it now is wasted work (no adversarial counterparty in the demo), but a future reader/auditor seeing no buyer-protection on `open_standby` should know it was a deliberate v1 scoping decision, mandatory before real external financiers onboard. (Flagged by the Phase-1/synthesis agent.)

---

## V5 Vault state additions (the data the credit layer needs)

Append to the `Vault` struct (new V5 fields, all default 0/None for migrated V4 vaults):
- `borrowed: u64` — amount the financier has fronted that the buyer hasn't repaid. The "buyer is negative" accumulator. Rises on draw, falls on repay/seize.
- `standby_backer: Option<Pubkey>` — the financier's vault (swig_address) authorized to back this vault. `None` = no credit enabled.
- `standby_cap: u64` — the ceiling $N the financier committed. `borrowed` may never exceed this.
- `borrow_recovery_at: Option<i64>` — the deadline after which the financier may seize. Set on first draw, cleared on full repay.

(Exact placement + the frozen `VaultV4` decoder struct are specified in the migration task. Naming may be refined at build time, but these four concepts are the locked surface.)

---

## File Structure

**On-chain (programs/dexter-vault/src/):**
- Modify: `state.rs` — add `VAULT_VERSION_V5`, the 4 V5 Vault fields, new `VaultError` variants (`CreditWouldExceedStandbyCap`, `WithdrawalWouldViolatePin`, `BorrowRecoveryTooEarly`, `NoStandbyBacker`, `NothingBorrowed`).
- Create: `instructions/open_standby.rs` — financier's standing pre-authorization (sets `standby_backer`, `standby_cap` on the user's vault; financier signs).
- Create: `instructions/draw_credit.rs` — the borrow: buyer overspends, chain draws from financier's vault → seller, raises `borrowed`, pins collateral, sets `borrow_recovery_at`. Two-ix SignV2 shape (financier swig funds it).
- Create: `instructions/repay_credit.rs` — lower `borrowed` (and clear `borrow_recovery_at` when it hits 0). Unpins as it repays.
- Create: `instructions/seize_collateral.rs` — the liquidation: after `borrow_recovery_at`, financier reclaims the borrowed slice from the user's pinned collateral. Mirror of recover_abandoned_lock.
- Create: `instructions/migrate_v4_to_v5.rs` — decode-V4 / re-encode-V5, frozen `VaultV4` snapshot.
- Modify: `instructions/finalize_withdrawal.rs` — extend the reservation guard to subtract `borrowed` (the pin) from withdrawable balance.
- Modify: `instructions/mod.rs` + `lib.rs` — wire the 5 new instructions.

**SDK (dexter-vault-sdk/src/):**
- Modify: `constants/index.ts` — 5 new discriminators.
- Create: `instructions/credit.ts` — builders: `buildOpenStandbyInstruction`, `buildDrawCreditInstruction`, `buildRepayCreditInstruction`, `buildSeizeCollateralInstruction`.
- Modify: `instructions/index.ts` — export them.

**Tests:**
- `dexter-vault/tests/credit-*.ts` — mainnet tests: open→draw→repay happy path; the anti-rug proofs (draw past cap rejected; withdraw-below-pin rejected; seize-before-deadline rejected); the full borrow→abandon→seize lifecycle.
- `dexter-vault-sdk/tests/credit.byte-parity.test.ts` — builder byte-parity.

---

## PHASE A — On-chain program (Rust)

### Task 1: V5 state + errors

**Files:**
- Modify: `programs/dexter-vault/src/state.rs`

- [ ] **Step 1: Add the version constant + V5 fields to the Vault struct**

In `state.rs`, after `VAULT_VERSION_V4`:
```rust
/// V5 appends credit accounting: external-financier standby backing.
/// `borrowed` is the "buyer is negative" accumulator. New vaults init as V5.
pub const VAULT_VERSION_V5: u8 = 5;
```
Append to the `Vault` struct (after `total_settled_amount`, the last V4 field):
```rust
    /// Amount an external financier has fronted that the buyer has NOT repaid.
    /// The credit ("buyer is negative") accumulator. Rises at `draw_credit`,
    /// falls at `repay_credit` / `seize_collateral`. MUST never exceed `standby_cap`.
    pub borrowed: u64,
    /// The financier's vault (swig_address) authorized to back this vault past
    /// the user's own balance. `None` = no credit enabled. Set by `open_standby`.
    pub standby_backer: Option<Pubkey>,
    /// The ceiling the financier committed. `borrowed <= standby_cap` always.
    pub standby_cap: u64,
    /// Deadline after which the financier may `seize_collateral`. Set on the
    /// first draw, cleared when `borrowed` returns to 0. None = nothing borrowed.
    pub borrow_recovery_at: Option<i64>,
```

- [ ] **Step 2: Add the new error variants**

In the `VaultError` enum in `state.rs`, append:
```rust
    #[msg("Draw would exceed the financier's committed standby cap.")]
    CreditWouldExceedStandbyCap,
    #[msg("Withdrawal would violate the credit pin (borrowed amount is reserved).")]
    WithdrawalWouldViolatePin,
    #[msg("Borrow recovery deadline has not passed yet.")]
    BorrowRecoveryTooEarly,
    #[msg("No standby backer is configured for this vault.")]
    NoStandbyBacker,
    #[msg("Nothing is borrowed on this vault.")]
    NothingBorrowed,
```

- [ ] **Step 3: Build the program (compile check only — no deploy)**

Run: `export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH" && cd /home/branchmanager/websites/dexter-vault && cargo build-sbf 2>&1 | tail -20`
Expected: compiles clean. (New fields/errors are additive; no handler uses them yet, so this just confirms the struct + enum compile.)

- [ ] **Step 4: Commit**

```bash
git add programs/dexter-vault/src/state.rs
git commit -m "feat(vault): V5 state — credit accounting fields + standby errors"
```

### Task 2: `open_standby` — the financier's standing pre-authorization

**Files:**
- Create: `programs/dexter-vault/src/instructions/open_standby.rs`
- Modify: `programs/dexter-vault/src/instructions/mod.rs`, `programs/dexter-vault/src/lib.rs`

- [ ] **Step 1: Write the instruction**

Create `open_standby.rs`. The financier authorizes backing the USER's vault up to `cap`. Accounts: the user's `vault` (mut), the financier's `financier_swig` (their vault's swig_address, signs via passkey OR a financier authority key — use the same passkey-verify pattern as other authorizing ixs; the financier proves control of their backing vault), `instructions_sysvar`. Args: `cap: u64` + the financier's passkey ceremony bytes (`client_data_json`, `authenticator_data`) signing op-message `"open_standby" || user_vault || financier_swig || cap_le`.

Handler logic:
```rust
// validate the financier passkey signature over "open_standby" || vault || financier_swig || cap
// set vault.standby_backer = Some(financier_swig.key())
// set vault.standby_cap = cap
require!(cap > 0, VaultError::...); // a zero cap is a no-op / disable path could be separate
vault.standby_backer = Some(ctx.accounts.financier_swig.key());
vault.standby_cap = cap;
```
(Follow the exact account-struct + secp256r1 sibling-instruction verification pattern from `register_session_key.rs` / `recover_abandoned_lock.rs`. The op-message domain string is new: `"open_standby"`.)

- [ ] **Step 2: Wire it in mod.rs + lib.rs**

Add `pub mod open_standby; pub use open_standby::*;` to `mod.rs`, and the `pub fn open_standby(...)` entry to `lib.rs` following the existing instruction-handler signature pattern.

- [ ] **Step 3: Build (compile check)**

Run: `export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH" && cd /home/branchmanager/websites/dexter-vault && cargo build-sbf 2>&1 | tail -20`
Expected: compiles clean.

- [ ] **Step 4: Commit**

```bash
git add programs/dexter-vault/src/instructions/open_standby.rs programs/dexter-vault/src/instructions/mod.rs programs/dexter-vault/src/lib.rs
git commit -m "feat(vault): open_standby — financier standing pre-authorization (credit backing)"
```

### Task 3: `draw_credit` — the borrow (buyer goes negative)

**Files:**
- Create: `programs/dexter-vault/src/instructions/draw_credit.rs`
- Modify: `mod.rs`, `lib.rs`

- [ ] **Step 1: Write the instruction**

The draw: the buyer's spend has exceeded their own balance; draw `amount` from the financier's vault to the seller, raise `borrowed`, pin, set the recovery deadline. This is the two-ix SignV2 shape but the swig is the FINANCIER's (their vault funds it). Accounts (order matters — model on `settle_locked_voucher.rs`): `financier_swig` (the backing vault's swig, == vault.standby_backer), `financier_swig_wallet_address` (PDA), the user's `vault` (mut), `seller_ata` or the destination, `dexter_authority` (signer — orchestration authority that drives the draw under the financier's standing auth), `instructions_sysvar`. Args: `amount: u64`, `recovery_window_seconds: i64` (to compute `borrow_recovery_at`).

Handler guards (THE ANTI-RUG CORE — model on lock_voucher's overcommit guard):
```rust
let backer = vault.standby_backer.ok_or(VaultError::NoStandbyBacker)?;
require!(backer == ctx.accounts.financier_swig.key(), VaultError::NoStandbyBacker);
// G: never draw past the committed cap
let new_borrowed = vault.borrowed.checked_add(amount).ok_or(...)?;
require!(new_borrowed <= vault.standby_cap, VaultError::CreditWouldExceedStandbyCap);
vault.borrowed = new_borrowed;
// set the recovery deadline on first draw
let now = Clock::get()?.unix_timestamp;
if vault.borrow_recovery_at.is_none() {
    vault.borrow_recovery_at = Some(now + args.recovery_window_seconds);
}
// the actual USDC move is the following swig::SignV2 from the FINANCIER's swig_wallet ATA.
```
Register the `draw_credit` discriminator as a ProgramExec marker for the financier's swig (the SignV2 validates accounts[0..1] == [financier_swig, financier_swig_wallet]).

- [ ] **Step 2: Wire it (mod.rs + lib.rs)**

- [ ] **Step 3: Build (compile check)**

Run: `export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH" && cd /home/branchmanager/websites/dexter-vault && cargo build-sbf 2>&1 | tail -20`
Expected: compiles clean.

- [ ] **Step 4: Commit**

```bash
git add programs/dexter-vault/src/instructions/draw_credit.rs programs/dexter-vault/src/instructions/mod.rs programs/dexter-vault/src/lib.rs
git commit -m "feat(vault): draw_credit — borrow against financier standby (cap-guarded)"
```

### Task 4: `repay_credit` — pay down the borrowed slice

**Files:**
- Create: `programs/dexter-vault/src/instructions/repay_credit.rs`
- Modify: `mod.rs`, `lib.rs`

- [ ] **Step 1: Write the instruction**

Repay: move `amount` USDC from the user's vault back to the financier's vault, lower `borrowed`. When `borrowed` hits 0, clear `borrow_recovery_at` (unpin). Two-ix SignV2 from the USER's swig (the user's funds repay). Accounts: user `swig` + `swig_wallet_address`, user `vault` (mut), financier destination, `dexter_authority`, `instructions_sysvar`. Args: `amount: u64`.

Handler:
```rust
require!(vault.borrowed > 0, VaultError::NothingBorrowed);
let repay = amount.min(vault.borrowed); // never over-repay
vault.borrowed = vault.borrowed.saturating_sub(repay);
if vault.borrowed == 0 {
    vault.borrow_recovery_at = None; // fully repaid → unpin
}
// the SignV2 moves `repay` from user swig_wallet ATA → financier ATA.
```

- [ ] **Step 2: Wire it.**
- [ ] **Step 3: Build (compile check).** Run the cargo build-sbf command; expect clean.
- [ ] **Step 4: Commit**
```bash
git add programs/dexter-vault/src/instructions/repay_credit.rs programs/dexter-vault/src/instructions/mod.rs programs/dexter-vault/src/lib.rs
git commit -m "feat(vault): repay_credit — pay down borrowed, unpin at zero"
```

### Task 5: `seize_collateral` — deadline liquidation (mirror of recover_abandoned_lock)

**Files:**
- Create: `programs/dexter-vault/src/instructions/seize_collateral.rs`
- Modify: `mod.rs`, `lib.rs`

- [ ] **Step 1: Write the instruction (model EXACTLY on recover_abandoned_lock.rs)**

After the deadline, the financier reclaims the borrowed slice from the user's pinned collateral. Accounts: user `swig` + `swig_wallet_address`, user `vault` (mut), financier destination ATA, `dexter_authority`, `instructions_sysvar`. Args: none (or the financier's proof — mirror recover_abandoned_lock's arg shape).

Handler (the mirror):
```rust
let now = Clock::get()?.unix_timestamp;
require!(vault.borrowed > 0, VaultError::NothingBorrowed);
let deadline = vault.borrow_recovery_at.ok_or(VaultError::NothingBorrowed)?;
require!(now >= deadline, VaultError::BorrowRecoveryTooEarly);
let seized = vault.borrowed;
vault.borrowed = 0;
vault.borrow_recovery_at = None;
// the SignV2 moves `seized` from user swig_wallet ATA → financier ATA (the seizure).
```

- [ ] **Step 2: Wire it.**
- [ ] **Step 3: Build (compile check).** cargo build-sbf; expect clean.
- [ ] **Step 4: Commit**
```bash
git add programs/dexter-vault/src/instructions/seize_collateral.rs programs/dexter-vault/src/instructions/mod.rs programs/dexter-vault/src/lib.rs
git commit -m "feat(vault): seize_collateral — deadline liquidation (mirror of recover_abandoned_lock)"
```

### Task 6: Extend `finalize_withdrawal` with the credit pin

**Files:**
- Modify: `programs/dexter-vault/src/instructions/finalize_withdrawal.rs`

- [ ] **Step 1: Add `borrowed` to the reservation guard**

The existing reservation guard prevents withdrawing below `outstanding_locked_amount`. Extend it so the withdrawable balance also subtracts `borrowed` (the pin): the user cannot withdraw collateral that's backing an open loan.

Find the existing reservation check (it computes available = live_balance - outstanding_locked_amount and rejects if the withdrawal would breach it, with `WithdrawalWouldViolateReservation`). Add the pin:
```rust
// Credit pin (V5): borrowed collateral is reserved until repaid/seized.
let reserved = vault.outstanding_locked_amount
    .checked_add(vault.borrowed)
    .ok_or(VaultError::...)?;
// available = live_usdc_balance - reserved; reject if withdrawal exceeds available
require!(
    withdrawal_amount <= live_balance.saturating_sub(reserved),
    VaultError::WithdrawalWouldViolatePin
);
```
(Match the EXACT existing variable names + guard structure in finalize_withdrawal.rs; this is an extension of the existing check, not a rewrite. If the existing guard uses `WithdrawalWouldViolateReservation` for the locked-amount breach, keep that, and use `WithdrawalWouldViolatePin` specifically for the borrowed breach — or fold both into the reserved sum and pick the message that best describes the dominant cause. Implementer: read the existing guard and choose the cleanest extension that distinguishes "locked" from "borrowed" breaches.)

- [ ] **Step 2: Build (compile check).** cargo build-sbf; expect clean.
- [ ] **Step 3: Commit**
```bash
git add programs/dexter-vault/src/instructions/finalize_withdrawal.rs
git commit -m "feat(vault): finalize_withdrawal pins borrowed collateral (credit pin)"
```

### Task 7: `migrate_v4_to_v5`

**Files:**
- Create: `programs/dexter-vault/src/instructions/migrate_v4_to_v5.rs`
- Modify: `mod.rs`, `lib.rs`

- [ ] **Step 1: Write the migration (model EXACTLY on migrate_v3_to_v4.rs)**

Decode the on-chain V4 account with a hand-frozen `VaultV4` struct (== current `Vault` MINUS the 4 V5 fields), re-encode as the current V5 `Vault` with `borrowed=0, standby_backer=None, standby_cap=0, borrow_recovery_at=None`. Realloc for the added bytes (8 + 1 + 32-ish for the Option<Pubkey> + 8 + 1-ish for Option<i64> — compute exact). Copy the DANGER doc comment pattern from migrate_v3_to_v4.rs (frozen-struct rationale, why decode is safe). Validate: discriminator match, version == 4, authority check.

- [ ] **Step 2: Wire it.**
- [ ] **Step 3: Build (compile check).** cargo build-sbf; expect clean. Confirm the full program now has 24 instructions (19 + open_standby, draw_credit, repay_credit, seize_collateral, migrate_v4_to_v5).
- [ ] **Step 4: Commit**
```bash
git add programs/dexter-vault/src/instructions/migrate_v4_to_v5.rs programs/dexter-vault/src/instructions/mod.rs programs/dexter-vault/src/lib.rs
git commit -m "feat(vault): migrate_v4_to_v5 — decode-V4/re-encode-V5 for credit fields"
```

---

## PHASE B — GATED MAINNET DEPLOY (Branch's explicit go required)

### Task 8: Deploy the upgraded program to mainnet

**THIS TASK REQUIRES BRANCH'S EXPLICIT PER-STEP APPROVAL. Do not run the deploy without it.**

- [ ] **Step 1: Full local build + IDL emit**

Run: `export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH" && cd /home/branchmanager/websites/dexter-vault && anchor build 2>&1 | tail -20`
Expected: clean build, `target/idl/dexter_vault.json` updated with the 5 new instructions + V5.

- [ ] **Step 2: Confirm wallet SOL (need ~3.1+ for the transient buffer)**

Run: `export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH" && solana balance X4o2kSLzqEQjnAzhq3L3BW92aawMV2n2F37EXd2GMpy --url "https://mainnet.helius-rpc.com/?api-key=8fd1a2cd-76e7-4462-b38b-1026960edd40"`
Expected: ≥ 3.1 SOL. If short, STOP and tell Branch the top-up amount.

- [ ] **Step 3: Extend program-data account (pays only the size delta)**

Run (BRANCH-APPROVED): `solana program extend Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc <bytes> --url <HELIUS>`
(Compute `<bytes>` = new .so size − current program-data size.)

- [ ] **Step 4: Deploy (BRANCH-APPROVED)**

Run: `solana program deploy target/deploy/dexter_vault.so --program-id Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc --upgrade-authority ~/.config/solana/dexter-vault/upgrade-authority.json --url <HELIUS>`
Expected: success; record the upgrade signature + new .so hash.

- [ ] **Step 5: Verify on-chain**

Confirm the program now exposes 24 instructions (check the deployed IDL or a getAccountInfo on the program-data). Record the receipts in a deploy note.

---

## PHASE C — SDK builders + mainnet tests

### Task 9: SDK discriminators + credit instruction builders

**Files:**
- Modify: `dexter-vault-sdk/src/constants/index.ts`
- Create: `dexter-vault-sdk/src/instructions/credit.ts`
- Modify: `dexter-vault-sdk/src/instructions/index.ts`
- Test: `dexter-vault-sdk/tests/credit.byte-parity.test.ts`

- [ ] **Step 1: Add the 5 discriminators to constants**

Compute `sha256("global:<ix>")[..8]` for `open_standby`, `draw_credit`, `repay_credit`, `seize_collateral`, `migrate_v4_to_v5`, cross-check against the freshly-built `dexter-vault/target/idl/dexter_vault.json` (the Plan-0 lesson: the bundled SDK IDL is stale; use the program's fresh one + sha256). Add to the `DISCRIMINATORS` map.

- [ ] **Step 2: Write byte-parity tests (TDD — the Plan-0 pattern)**

Create `tests/credit.byte-parity.test.ts` asserting each builder's account order, signer/writable flags, and arg layout against the on-chain structs. (Mirror the structure of `tests/lockedClaim.byte-parity.test.ts`.) Run, watch fail.

- [ ] **Step 3: Write the 4 builders in `credit.ts`**

`buildOpenStandbyInstruction`, `buildDrawCreditInstruction`, `buildRepayCreditInstruction`, `buildSeizeCollateralInstruction` — each mirroring the lockedClaim.ts builder pattern (discriminator + encoded args + account list matching the Rust struct exactly, swig-wallet PDAs derived via `deriveSwigWalletAddress`). Run tests, watch pass.

- [ ] **Step 4: Export + build + full suite**

Add exports to `instructions/index.ts`; `npx tsc --noEmit && npm run build && npx vitest run`. Expect all green.

- [ ] **Step 5: Commit** (source only, no publish)
```bash
git add dexter-vault-sdk/src/constants/index.ts dexter-vault-sdk/src/instructions/credit.ts dexter-vault-sdk/src/instructions/index.ts dexter-vault-sdk/tests/credit.byte-parity.test.ts
git commit -m "feat(vault-sdk): credit instruction builders (open_standby/draw/repay/seize)"
```

### Task 10: Mainnet credit lifecycle + anti-rug tests

**Files:**
- Create: `dexter-vault/tests/credit-lifecycle.ts`, `dexter-vault/tests/credit-antirug.ts`

(Mainnet tests — secp256r1 is mainnet-only. Use the Helius RPC + the shared settle harness `tests/helpers/settle.ts` + `enrollLockableVault` for exact funding. Each provisioning ~140-160s; use `-g` to target.)

**Test framing (v1 = no credit model — the cap + pin + short duration IS the risk management):** v1 credit is short, sub-minute, auto-repaying SLIVERS — there is deliberately NO underwriting / credit-scoring logic (that's Ζ, after the credit graph exists). The safety in v1 comes entirely from three things the tests must prove: the `standby_cap` guard, the collateral pin, and short loan duration with auto-repay-first (`repay_credit` draws `borrowed` down before crediting the user). So the lifecycle test should model the canonical case — float a small amount, auto-repay on the next settlement — not a long-held loan. Keep loans/recovery windows short so the lifecycle runs fast and clean.

- [ ] **Step 1: Happy path — open → draw → repay**

Provision a user vault + a financier vault (both funded). `open_standby` (financier backs user up to $N). Drive a draw that takes the user negative (spend past their balance), assert `borrowed` rose, the seller received USDC from the FINANCIER's vault, `borrow_recovery_at` set. Repay, assert `borrowed` falls to 0 and `borrow_recovery_at` clears. Run on mainnet, prove green.

- [ ] **Step 2: Anti-rug #1 — draw past cap rejected**

`open_standby` with cap $5, attempt a draw of $6 → expect `CreditWouldExceedStandbyCap`. (The financier's committed ceiling holds.)

- [ ] **Step 3: Anti-rug #2 — withdraw below pin rejected**

Draw $4 (borrowed=4), then attempt `finalize_withdrawal` that would pull collateral below the pin → expect `WithdrawalWouldViolatePin`. (The buyer can't yank collateral out from under the open loan.)

- [ ] **Step 4: Anti-rug #3 — seize before deadline rejected**

Draw, then attempt `seize_collateral` before `borrow_recovery_at` → expect `BorrowRecoveryTooEarly`. (The financier can't grab early.)

- [ ] **Step 5: Lifecycle — borrow → abandon → seize (happy seize)**

Draw with a SHORT recovery window (or document a manual-wait skip like recover-abandoned-lock's 90-day tests), let the deadline pass (or skip with the documented protocol), `seize_collateral`, assert the financier reclaimed `borrowed` from the user's collateral and `borrowed→0`. (Mirror the recover-abandoned-lock test's skip pattern for the wall-clock wait.)

- [ ] **Step 6: Commit the test results**
```bash
git add dexter-vault/tests/credit-lifecycle.ts dexter-vault/tests/credit-antirug.ts
git commit -m "test(vault): credit L2 lifecycle + anti-rug proofs GREEN on mainnet"
```

---

## Final verification

- [ ] All Phase A tasks compile (`cargo build-sbf` clean); the program reaches 24 instructions.
- [ ] Phase B deploy: ONLY with Branch's explicit go; receipts recorded.
- [ ] Phase C: SDK builders byte-parity green; mainnet lifecycle + all 3 anti-rug proofs green (real failed txs for the rejections).
- [ ] The thesis proven: a buyer spent PAST their balance on a financier's standby capital, non-custodially (financier funds never escrowed), the buyer could NOT rug the financier (cap + pin + seize all enforced on-chain).
- [ ] NO publish, NO version bump on the SDK (Branch-gated). The program deploy is the one gated mainnet action.
- [ ] Update ALPHA-TO-ZETA: flip Ε to ✅ (or note Credit-L2 shipped) once green.

---

## Notes for the executor

- **The anti-rug guards are the whole point** — `CreditWouldExceedStandbyCap` (can't borrow past the committed pool), `WithdrawalWouldViolatePin` (can't withdraw pinned collateral), `BorrowRecoveryTooEarly` (financier can't seize early). Each must be proven with a REAL failed mainnet tx, exactly like the Phase 1 anti-rug trio. Do not weaken these tests.
- **Custody is Option A — NO pool account.** The financier's funds stay in their own vault; the draw is a SignV2 from the FINANCIER's swig_wallet. Do not build a pool PDA.
- **Authorization is standing.** `open_standby` is the one-time financier signature; draws need no per-draw financier co-sign (the cap guard is what protects them). `dexter_authority` drives draws under the standing auth.
- **Liquidation mirrors recover_abandoned_lock** — same deadline → re-credit → status pattern, pointed financier-ward. Port that file's structure.
- **Migration mirrors migrate_v3_to_v4** — frozen VaultV4 decoder, decode/re-encode, NOT append-zero-fill. Copy the DANGER doc.
- **The deploy is gated.** Phase A + C code can all be built and tested-against-a-local-validator-where-possible, but the secp256r1 mainnet tests (Phase C) require the deployed program — so Phase B (gated) sits between A and C. Build all of A, get Branch's deploy go, then C.
- **Spread/fee is operator policy** — not in the program. The financier earns the spread; how, is a consumer/dexter-api concern (like the withdrawal fee + factoring spread).
- **RPC: ALWAYS Helius**, never mainnet-beta. Sandbox disabled for fetch in mainnet tests.
