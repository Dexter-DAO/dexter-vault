//! Settle a LockedClaim: move the reserved USDC from the swig wallet ATA
//! to the current_holder's ATA, decrement outstanding_locked_amount,
//! advance total_settled_amount, mark the claim Settled.
//!
//! Per V0.3 Decision 7, this instruction is FULLY INDEPENDENT of
//! `vault.active_session`. It does not read, write, or reference the
//! session. The claim contains every field needed at settle time:
//! `current_holder`, `amount`, `maturity_at`. The session that originally
//! crystallized the claim may have been revoked, expired, or replaced —
//! settlement proceeds regardless. This is the seam that makes revoke
//! unable to break settlement.
//!
//! Transaction shape (two instructions, atomic):
//!   [N]   vault::settle_locked_voucher  ← this instruction
//!           validates maturity (if any), holder signature, mutates state
//!   [N+1] swig::SignV2(TransferChecked)
//!           Swig validates accounts[0..1] of THIS instruction equal
//!           [swig, swig_wallet] AND that the preceding instruction's
//!           data starts with the settle_locked_voucher discriminator
//!           (registered as a ProgramExec marker). On match, executes
//!           the SPL transfer from swig_wallet_ata → holder_ata as a
//!           ProgramExec authority.
//!
//! IMPORTANT: the settle_locked_voucher discriminator MUST be added to
//! the Swig's ProgramExec marker list. New vaults created after the
//! marker registration will work; older Swigs (registered with only the
//! settle_tab_voucher + finalize_withdrawal markers) cannot use this
//! instruction. SDK marker-list update is Phase 2 SDK work; Phase 1
//! tests register the new marker manually on fresh enrollment.

use anchor_lang::prelude::*;

use crate::constants::{SWIG_PROGRAM_ID, SWIG_WALLET_ADDRESS_SEED};
use crate::state::*;

#[derive(Accounts)]
pub struct SettleLockedVoucher<'info> {
    /// Position 0 — required at this index by Swig's ProgramExec validator.
    /// CHECK: address constraint binds to vault.swig_address; never deref.
    #[account(address = vault.swig_address)]
    pub swig: AccountInfo<'info>,

    /// Position 1 — required by Swig's ProgramExec validator.
    /// CHECK: PDA constraint validates derivation; never deref.
    #[account(
        seeds = [SWIG_WALLET_ADDRESS_SEED, swig.key().as_ref()],
        bump,
        seeds::program = SWIG_PROGRAM_ID,
    )]
    pub swig_wallet_address: AccountInfo<'info>,

    #[account(
        mut,
        constraint = claim.status == LockedClaimStatus::Pending
            @ VaultError::LockRangeAlreadyClaimed,
        constraint = claim.vault == vault.key()
            @ VaultError::PasskeyVerificationFailed,
    )]
    pub claim: Account<'info, LockedClaim>,

    /// Accumulator vault. Mutated to decrement outstanding_locked_amount
    /// and advance total_settled_amount. Per V0.3 Decision 7, the
    /// `active_session` field is NOT read here.
    #[account(mut)]
    pub vault: Account<'info, Vault>,

    /// Must equal claim.current_holder. This signature is the sole
    /// authority for the settlement.
    #[account(
        constraint = claim.current_holder == holder.key()
            @ VaultError::PasskeyVerificationFailed,
    )]
    pub holder: Signer<'info>,

    /// Fee gate (matches settle_tab_voucher's discipline).
    #[account(
        constraint = vault.dexter_authority == dexter_authority.key()
            @ VaultError::PasskeyVerificationFailed,
    )]
    pub dexter_authority: Signer<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SettleLockedVoucherArgs {}

pub fn handler(
    ctx: Context<SettleLockedVoucher>,
    _args: SettleLockedVoucherArgs,
) -> Result<()> {
    let claim = &mut ctx.accounts.claim;
    let vault = &mut ctx.accounts.vault;

    let now = Clock::get()?.unix_timestamp;

    // V0.3 Decision 3: if maturity_at is set, enforce it. Reuses
    // CoolingOffNotElapsed semantically — same "the future hasn't arrived"
    // shape.
    if let Some(maturity) = claim.maturity_at {
        require!(now >= maturity, VaultError::CoolingOffNotElapsed);
    }

    // V0.3 Decision 1: accumulator mutation. outstanding_locked_amount
    // FALLS by the settled amount; total_settled_amount RISES by the
    // settled amount (lifetime monotonic odometer).
    vault.outstanding_locked_amount = vault
        .outstanding_locked_amount
        .saturating_sub(claim.amount);
    vault.total_settled_amount = vault
        .total_settled_amount
        .saturating_add(claim.amount);

    // V0.3 Decision 6: state machine transition. Pending → Settled,
    // terminal one-way.
    claim.status = LockedClaimStatus::Settled;
    claim.settled_at = Some(now);
    // recovered_at stays None (per Decision 6: only abandonment sets it).

    Ok(())
}
