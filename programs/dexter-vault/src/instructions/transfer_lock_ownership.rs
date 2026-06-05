//! Transfer ownership of a LockedClaim to a new holder. The claim's status
//! is unchanged (remains Pending); only `current_holder` mutates. This is
//! the instruction a seller uses to sell their claim to a financier.
//!
//! V0.3 Decision 6: this instruction MUST NOT mutate `status`. The state
//! machine is `pending → {settled, abandoned}` only. Transfer is a sideways
//! mutation that preserves the state machine.
//!
//! V0.3 Decision 1: this instruction MUST NOT touch
//! `vault.outstanding_locked_amount` or any other accumulator. The
//! reservation invariants are independent of holder identity — what's
//! reserved stays reserved, just owned by someone different.

use anchor_lang::prelude::*;

use crate::state::*;

#[derive(Accounts)]
pub struct TransferLockOwnership<'info> {
    #[account(
        mut,
        constraint = claim.status == LockedClaimStatus::Pending
            @ VaultError::LockRangeAlreadyClaimed,
    )]
    pub claim: Account<'info, LockedClaim>,

    /// Must equal the claim's current_holder. This is the sole authority
    /// for transferring the claim per the reservation semantics doc
    /// (Reservation 2).
    #[account(
        constraint = claim.current_holder == current_holder.key()
            @ VaultError::PasskeyVerificationFailed,
    )]
    pub current_holder: Signer<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TransferLockOwnershipArgs {
    pub new_holder: Pubkey,
}

pub fn handler(
    ctx: Context<TransferLockOwnership>,
    args: TransferLockOwnershipArgs,
) -> Result<()> {
    let claim = &mut ctx.accounts.claim;
    claim.current_holder = args.new_holder;
    // status, amount, all other fields unchanged.
    Ok(())
}
