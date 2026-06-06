//! Credit Level 2 — `draw_credit`. THE BORROW. The agent's spend exceeded the
//! USER's own balance, so this instruction draws `amount` from the FINANCIER's
//! vault to the seller, raises `vault.borrowed`, and arms the recovery deadline.
//! This is the anti-rug core: the cap guard `borrowed + amount <= standby_cap`
//! lives here and can never be bypassed.
//!
//! CRITICAL — WHOSE SWIG: unlike `settle_locked_voucher` (whose swig at
//! accounts[0..1] is the USER's `vault.swig_address`), the money here comes from
//! the FINANCIER's vault. So the swig at accounts[0..1] MUST be the FINANCIER's
//! swig — constrained to `vault.standby_backer`, NOT `vault.swig_address`. The
//! financier's `swig_wallet_address` PDA derives from the financier's swig, and
//! the following SignV2 TransferChecked moves USDC out of the FINANCIER's
//! swig_wallet ATA. Using the user's swig would draw from the wrong vault.
//!
//! Because `standby_backer` is `Option<Pubkey>`, an `#[account(address = ...)]`
//! constraint cannot bind directly to it. The financier-swig identity is
//! therefore enforced in the HANDLER: read `vault.standby_backer`, require it
//! equals `financier_swig.key()`.
//!
//! Transaction shape (two instructions, atomic) — identical to
//! settle_locked_voucher, only WHOSE swig changes:
//!   [N]   vault::draw_credit  ← this instruction
//!           validates standby backer, applies THE CAP GUARD, raises borrowed,
//!           arms borrow_recovery_at (first draw only). NO USDC moves here.
//!   [N+1] swig::SignV2(TransferChecked)
//!           Swig validates accounts[0..1] of THIS instruction equal
//!           [financier_swig, financier_swig_wallet] AND that the preceding
//!           instruction's data starts with the draw_credit discriminator
//!           (registered as a ProgramExec marker on the FINANCIER's swig). On
//!           match, executes the SPL transfer from financier_swig_wallet_ata →
//!           seller_ata as a ProgramExec authority.
//!
//! IMPORTANT: the draw_credit discriminator MUST be registered as a ProgramExec
//! marker on the FINANCIER's swig (not the user's). Tests handle marker
//! registration on fresh enrollment.
//!
//! The seller destination ATA is NOT an account on THIS instruction — exactly
//! like settle_locked_voucher's holder_ata, it is carried by the following
//! SignV2 TransferChecked. This instruction authorizes the draw and mutates
//! credit state; the SignV2 moves the money.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::constants::{SWIG_PROGRAM_ID, SWIG_WALLET_ADDRESS_SEED};
use crate::state::*;

#[derive(Accounts)]
pub struct DrawCredit<'info> {
    /// Position 0 — required at this index by Swig's ProgramExec validator.
    /// This is the FINANCIER's swig, NOT the user's `vault.swig_address`. It
    /// must equal `vault.standby_backer`; because that field is `Option<Pubkey>`
    /// the equality is enforced in the handler (an `#[account(address = ...)]`
    /// constraint can't bind to an Option).
    /// CHECK: identity-constrained in the handler against vault.standby_backer;
    /// never deref.
    pub financier_swig: AccountInfo<'info>,

    /// Position 1 — required by Swig's ProgramExec validator. Derives from the
    /// FINANCIER's swig, so the following SignV2 spends the FINANCIER's
    /// swig_wallet ATA.
    /// CHECK: PDA constraint validates derivation; never deref.
    #[account(
        seeds = [SWIG_WALLET_ADDRESS_SEED, financier_swig.key().as_ref()],
        bump,
        seeds::program = SWIG_PROGRAM_ID,
    )]
    pub financier_swig_wallet_address: AccountInfo<'info>,

    /// The USER's vault — borrowed accumulator rises here, recovery deadline is
    /// armed here. Mutated.
    #[account(mut)]
    pub vault: Account<'info, Vault>,

    /// The orchestration authority driving the draw under the financier's
    /// standing standby authorization. Matches settle_locked_voucher's fee gate.
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
pub struct DrawCreditArgs {
    /// USDC drawn from the financier's vault to the seller. The following
    /// SignV2 transfers exactly this amount.
    pub amount: u64,
    /// Seconds from now until the financier may `seize_collateral`. Used to set
    /// `borrow_recovery_at` on the FIRST draw only.
    pub recovery_window_seconds: i64,
}

pub fn handler(ctx: Context<DrawCredit>, args: DrawCreditArgs) -> Result<()> {
    // Match open_standby's version guard.
    require!(
        ctx.accounts.vault.version == VAULT_VERSION_V5,
        VaultError::UnsupportedVaultVersion
    );

    // The swig at accounts[0..1] MUST be the configured financier — the backer
    // whose vault funds the draw. Read the Option, require it present AND equal
    // to the financier_swig account passed in. This is what makes the draw pull
    // from the right vault.
    let backer = ctx
        .accounts
        .vault
        .standby_backer
        .ok_or(VaultError::NoStandbyBacker)?;
    require!(
        backer == ctx.accounts.financier_swig.key(),
        VaultError::NoStandbyBacker
    );

    let vault = &mut ctx.accounts.vault;

    // ── G — THE CAP GUARD (anti-rug core). Never draw past the committed cap.
    // checked_add first (overflow is itself an over-cap condition), then the
    // ceiling check. borrowed can never exceed standby_cap.
    let new_borrowed = vault
        .borrowed
        .checked_add(args.amount)
        .ok_or(VaultError::CreditWouldExceedStandbyCap)?;
    require!(
        new_borrowed <= vault.standby_cap,
        VaultError::CreditWouldExceedStandbyCap
    );
    vault.borrowed = new_borrowed;

    // Arm the recovery deadline on the FIRST draw only — subsequent draws must
    // NOT push the deadline out (that would let the buyer indefinitely defer
    // seizure by topping up the borrow).
    let now = Clock::get()?.unix_timestamp;
    if vault.borrow_recovery_at.is_none() {
        // No generic arithmetic-overflow error exists in VaultError; the cap
        // error is the documented fallback for a deadline overflow (a
        // pathological recovery_window_seconds).
        vault.borrow_recovery_at = Some(
            now.checked_add(args.recovery_window_seconds)
                .ok_or(VaultError::CreditWouldExceedStandbyCap)?,
        );
    }

    // The actual USDC move is the following swig::SignV2(TransferChecked) from
    // the FINANCIER's swig_wallet ATA → seller ATA. This instruction does NOT
    // call token::transfer itself — it authorizes the draw (mirroring
    // settle_locked_voucher). The draw_credit discriminator must be registered
    // as a ProgramExec marker on the FINANCIER's swig (tests handle this).
    Ok(())
}
