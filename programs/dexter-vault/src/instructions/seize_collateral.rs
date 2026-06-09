//! Credit Level 2 — `seize_collateral`. THE DEADLINE LIQUIDATION. The
//! financier-ward MIRROR of `recover_abandoned_lock`.
//!
//! Where `recover_abandoned_lock` is the BUYER's safety valve (after
//! `holder_recovery_at` passes, the buyer reclaims a vanished holder's
//! reservation), `seize_collateral` is the FINANCIER's safety valve: after
//! `borrow_recovery_at` passes, if the buyer never repaid the drawn credit, the
//! financier reclaims the borrowed slice from the USER's pinned collateral.
//!
//! Same SHAPE as recover_abandoned_lock, pointed the other way:
//!   recover_abandoned_lock: deadline check (now >= holder_recovery_at else
//!     ForceReleaseTooEarly) → re-credit the accumulator → status flip.
//!   seize_collateral:       deadline check (now >= borrow_recovery_at else
//!     BorrowRecoveryTooEarly) → zero out `borrowed` → clear the deadline.
//!
//! THE DEADLINE GUARD IS THE BUYER PROTECTION. `require!(now >=
//! borrow_recovery_at, BorrowRecoveryTooEarly)` runs BEFORE any state mutation:
//! the financier CANNOT seize one second early. This is unbypassable — the only
//! way out before the deadline is for the buyer to repay (repay_credit), which
//! lowers `borrowed` and, at 0, clears `borrow_recovery_at` so this path can
//! never arm.
//!
//! CRITICAL — WHOSE SWIG: the seizure SPENDS the USER's collateral, so money
//! flows USER → financier. The swig at accounts[0..1] MUST therefore be the
//! USER's `vault.swig_address` — identical to repay_credit (which also moves the
//! user's funds to the financier), NOT draw_credit's financier swig.
//!
//! Transaction shape (two instructions, atomic) — the swig is the USER's:
//!   [N]   vault::seize_collateral  ← this instruction
//!           after the deadline, snapshots `seized = vault.borrowed`, zeroes
//!           `borrowed`, clears `borrow_recovery_at`. NO USDC moves here.
//!   [N+1] swig::SignV2(TransferChecked)
//!           Swig validates accounts[0..1] of THIS instruction equal
//!           [swig, swig_wallet] AND that the preceding instruction's data
//!           starts with the seize_collateral discriminator (registered as a
//!           ProgramExec marker on the USER's swig — since the SignV2 spends the
//!           user's wallet). On match, executes the SPL transfer from
//!           user_swig_wallet_ata → financier_ata as a ProgramExec authority,
//!           transferring exactly `seized`.
//!
//! IMPORTANT: the amount transferred by the following SignV2 MUST be the snapshot
//! `seized` (= the `vault.borrowed` observed before zeroing). The financier
//! destination ATA is NOT an account on THIS instruction — exactly like
//! repay_credit's financier_ata and settle_locked_voucher's holder_ata, it is
//! carried by the following SignV2 TransferChecked. This instruction authorizes
//! the seizure and mutates credit state; the SignV2 moves the money. The
//! seize_collateral discriminator must be registered as a ProgramExec marker on
//! the USER's swig (tests handle this).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::constants::{SWIG_PROGRAM_ID, SWIG_WALLET_ADDRESS_SEED};
use crate::state::*;

#[derive(Accounts)]
pub struct SeizeCollateral<'info> {
    /// Position 0 — required at this index by Swig's ProgramExec validator.
    /// This is the USER's swig, address-constrained to `vault.swig_address`
    /// (same as repay_credit; the OPPOSITE of draw_credit's financier swig).
    /// The following SignV2 spends the USER's swig_wallet ATA to pay the
    /// financier the seized slice.
    /// CHECK: address constraint binds to vault.swig_address; never deref.
    #[account(address = vault.swig_address)]
    pub swig: AccountInfo<'info>,

    /// Position 1 — required by Swig's ProgramExec validator. Derives from the
    /// USER's swig, so the following SignV2 spends the USER's swig_wallet ATA.
    /// CHECK: PDA constraint validates derivation; never deref.
    #[account(
        seeds = [SWIG_WALLET_ADDRESS_SEED, swig.key().as_ref()],
        bump,
        seeds::program = SWIG_PROGRAM_ID,
    )]
    pub swig_wallet_address: AccountInfo<'info>,

    /// The USER's vault — `borrowed` is zeroed here and the recovery deadline is
    /// cleared here. Mutated.
    #[account(mut)]
    pub vault: Account<'info, Vault>,

    /// The orchestration authority driving the liquidation. Matches
    /// repay_credit / draw_credit's gate exactly. The financier is NOT
    /// passkey-verified in v1 — the deadline + dexter_authority are the gate.
    #[account(
        constraint = vault.dexter_authority == dexter_authority.key()
            @ VaultError::PasskeyVerificationFailed,
    )]
    pub dexter_authority: Signer<'info>,

    /// CHECK: instructions sysvar — address-constrained. The following
    /// instruction is the swig::SignV2 that introspects this one.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

/// Empty by design. Unlike `recover_abandoned_lock` (which carries WebAuthn
/// ceremony bytes because the BUYER must passkey-sign their own recovery),
/// `seize_collateral` takes NO args: the financier is not passkey-verified in
/// v1, and the seized amount is the on-chain `vault.borrowed` snapshot — never a
/// caller-supplied value. The deadline + dexter_authority are the entire gate.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SeizeCollateralArgs {}

pub fn handler(ctx: Context<SeizeCollateral>, _args: SeizeCollateralArgs) -> Result<()> {
    // Match repay_credit / draw_credit's version guard.
    require!(
        ctx.accounts.vault.version == VAULT_VERSION_V5 || ctx.accounts.vault.version == VAULT_VERSION_V6,
        VaultError::UnsupportedVaultVersion
    );

    let now = Clock::get()?.unix_timestamp;

    // Can't seize what isn't borrowed.
    require!(
        ctx.accounts.vault.borrowed > 0,
        VaultError::NothingBorrowed
    );

    // A vault with `borrowed > 0` but no armed deadline is not seizable — there
    // is nothing to liquidate against. (draw_credit arms borrow_recovery_at on
    // the first draw; repay_credit clears it at 0.)
    let deadline = ctx
        .accounts
        .vault
        .borrow_recovery_at
        .ok_or(VaultError::NothingBorrowed)?;

    // THE BUYER PROTECTION. The financier cannot seize before the deadline.
    // This runs BEFORE the state mutation below — unbypassable.
    require!(now >= deadline, VaultError::BorrowRecoveryTooEarly);

    let vault = &mut ctx.accounts.vault;

    // Snapshot the outstanding slice — this is exactly what the following SignV2
    // must transfer from the USER's swig_wallet ATA → financier ATA.
    let seized = vault.borrowed;

    // Liquidate: zero the outstanding slice and unpin the vault. Mirrors
    // recover_abandoned_lock's accumulator drop + deadline clear.
    vault.borrowed = 0;
    vault.borrow_recovery_at = None;

    // The actual USDC move is the following swig::SignV2(TransferChecked) from
    // the USER's swig_wallet ATA → financier ATA, transferring exactly `seized`.
    // This instruction does NOT call token::transfer itself — it authorizes the
    // liquidation and mutates credit state (mirroring recover_abandoned_lock /
    // repay_credit). The seize_collateral discriminator must be registered as a
    // ProgramExec marker on the USER's swig (tests handle this).
    let _ = seized;
    Ok(())
}
