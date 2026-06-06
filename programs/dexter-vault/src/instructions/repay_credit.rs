//! Credit Level 2 — `repay_credit`. THE PAYDOWN. The mirror of `draw_credit`:
//! where the draw pulled from the FINANCIER's vault to the seller and RAISED
//! `vault.borrowed`, the repay moves the USER's own funds back to the financier
//! and LOWERS `vault.borrowed`. When the outstanding slice hits exactly 0, the
//! recovery deadline is cleared — the vault is unpinned and the financier can
//! no longer seize.
//!
//! CRITICAL — WHOSE SWIG: this is the OPPOSITE of `draw_credit`. The money here
//! flows OUT of the USER's wallet (repaying the loan), so the swig at
//! accounts[0..1] MUST be the USER's `vault.swig_address` — the standard
//! `settle_locked_voucher` pattern, address-constrained directly. The following
//! SignV2 TransferChecked spends the USER's swig_wallet ATA. Using the
//! financier's swig (draw_credit's pattern) would repay from the WRONG vault.
//!
//! Transaction shape (two instructions, atomic) — identical to
//! settle_locked_voucher, the swig is the USER's:
//!   [N]   vault::repay_credit  ← this instruction
//!           clamps `amount` to outstanding `borrowed`, LOWERS borrowed by the
//!           clamped value, clears borrow_recovery_at iff borrowed reaches 0.
//!           NO USDC moves here.
//!   [N+1] swig::SignV2(TransferChecked)
//!           Swig validates accounts[0..1] of THIS instruction equal
//!           [swig, swig_wallet] AND that the preceding instruction's data
//!           starts with the repay_credit discriminator (registered as a
//!           ProgramExec marker on the USER's swig — since the SignV2 spends the
//!           user's wallet). On match, executes the SPL transfer from
//!           user_swig_wallet_ata → financier_ata as a ProgramExec authority.
//!
//! IMPORTANT: the amount transferred by the following SignV2 MUST be the CLAMPED
//! `repay` value (`args.amount.min(vault.borrowed)`), not the raw `args.amount`
//! — never over-repay. The repay_credit discriminator MUST be registered as a
//! ProgramExec marker on the USER's swig (not the financier's). Tests handle
//! marker registration on fresh enrollment.
//!
//! The financier destination ATA is NOT an account on THIS instruction — exactly
//! like settle_locked_voucher's holder_ata and draw_credit's seller_ata, it is
//! carried by the following SignV2 TransferChecked. This instruction authorizes
//! the paydown and mutates credit state; the SignV2 moves the money.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::constants::{SWIG_PROGRAM_ID, SWIG_WALLET_ADDRESS_SEED};
use crate::state::*;

#[derive(Accounts)]
pub struct RepayCredit<'info> {
    /// Position 0 — required at this index by Swig's ProgramExec validator.
    /// This is the USER's swig, address-constrained to `vault.swig_address`
    /// (the OPPOSITE of draw_credit's financier swig). The following SignV2
    /// spends the USER's swig_wallet ATA to repay the financier.
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

    /// The USER's vault — borrowed accumulator falls here, recovery deadline is
    /// cleared here when borrowed reaches 0. Mutated.
    #[account(mut)]
    pub vault: Account<'info, Vault>,

    /// The orchestration authority driving the paydown. Matches draw_credit's
    /// fee gate exactly.
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RepayCreditArgs {
    /// USDC the caller intends to repay. Clamped to outstanding `borrowed` so an
    /// over-repay never moves more than is owed. The following SignV2 transfers
    /// exactly the CLAMPED value (`amount.min(vault.borrowed)`).
    pub amount: u64,
}

pub fn handler(ctx: Context<RepayCredit>, args: RepayCreditArgs) -> Result<()> {
    // Match draw_credit's version guard.
    require!(
        ctx.accounts.vault.version == VAULT_VERSION_V5,
        VaultError::UnsupportedVaultVersion
    );

    // Can't repay what isn't borrowed.
    require!(
        ctx.accounts.vault.borrowed > 0,
        VaultError::NothingBorrowed
    );

    let vault = &mut ctx.accounts.vault;

    // Never over-repay: clamp the requested amount to the outstanding borrowed.
    // The following SignV2 must transfer exactly this clamped `repay`, NOT the
    // raw args.amount.
    let repay = args.amount.min(vault.borrowed);
    vault.borrowed = vault.borrowed.saturating_sub(repay);

    // Fully repaid → unpin. Clear the recovery deadline so the financier can no
    // longer seize. Cleared ONLY when borrowed reaches exactly 0.
    if vault.borrowed == 0 {
        vault.borrow_recovery_at = None;
    }

    // The actual USDC move is the following swig::SignV2(TransferChecked) from
    // the USER's swig_wallet ATA → financier ATA, repaying exactly `repay`. This
    // instruction does NOT call token::transfer itself — it authorizes the
    // paydown and mutates credit state (mirroring settle_locked_voucher /
    // draw_credit). The repay_credit discriminator must be registered as a
    // ProgramExec marker on the USER's swig (tests handle this).
    Ok(())
}
