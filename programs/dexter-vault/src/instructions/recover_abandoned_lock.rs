//! Buyer's safety valve against a vanished holder. Re-credits the
//! reservation to the vault's spendable balance and marks the claim
//! `Abandoned`. Does NOT transfer USDC — the funds stay in the swig
//! wallet ATA and become spendable again because the
//! `outstanding_locked_amount` accumulator drops.
//!
//! V0.3 Decision 4: this path requires `holder_recovery_at` to be set on
//! the claim and the current time to be at or past that deadline. Claims
//! created with `holder_recovery_at = None` are truly indefinite and
//! cannot be recovered (the holder is durable indefinitely — that is the
//! buyer's pre-commitment at lock time).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::state::*;
use crate::verify::webauthn::verify_passkey_signed;

#[derive(Accounts)]
pub struct RecoverAbandonedLock<'info> {
    #[account(
        mut,
        constraint = claim.status == LockedClaimStatus::Pending
            @ VaultError::NothingToRelease,
        constraint = claim.vault == vault.key()
            @ VaultError::PasskeyVerificationFailed,
    )]
    pub claim: Account<'info, LockedClaim>,

    #[account(mut)]
    pub vault: Account<'info, Vault>,

    /// CHECK: instructions sysvar — address-constrained.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RecoverAbandonedLockArgs {
    /// WebAuthn clientDataJSON; challenge must be sha256(operation_message).
    pub client_data_json: Vec<u8>,
    pub authenticator_data: Vec<u8>,
}

pub fn handler(
    ctx: Context<RecoverAbandonedLock>,
    args: RecoverAbandonedLockArgs,
) -> Result<()> {
    let claim = &mut ctx.accounts.claim;
    let vault = &mut ctx.accounts.vault;

    let now = Clock::get()?.unix_timestamp;

    // V0.3 Decision 4: a claim with no recovery deadline is truly
    // indefinite. The buyer cannot reclaim. Reject as nothing-to-release
    // semantically.
    let recovery_at = claim
        .holder_recovery_at
        .ok_or(VaultError::NothingToRelease)?;

    require!(now >= recovery_at, VaultError::ForceReleaseTooEarly);

    // The buyer must sign this exact recovery with their passkey. Bind
    // the message to vault PDA + claim PDA so a signature cannot be
    // replayed against a different claim or a different vault.
    let mut op_msg = Vec::with_capacity(b"recover_abandoned_lock".len() + 32 + 32);
    op_msg.extend_from_slice(b"recover_abandoned_lock");
    op_msg.extend_from_slice(vault.key().as_ref());
    op_msg.extend_from_slice(claim.key().as_ref());

    verify_passkey_signed(
        &ctx.accounts.instructions_sysvar,
        &vault.passkey_pubkey,
        &args.client_data_json,
        &args.authenticator_data,
        &op_msg,
    )?;

    // V0.3 Decision 1: re-credit the reservation. outstanding_locked_amount
    // decrements; total_settled_amount does NOT advance (no settlement
    // occurred — this is reservation reclaim, not collection). The USDC
    // never moved; the accumulator drop is what makes those funds
    // spendable again under the per-vault invariant.
    vault.outstanding_locked_amount = vault
        .outstanding_locked_amount
        .saturating_sub(claim.amount);

    // V0.3 Decision 6: state machine transition. Pending → Abandoned,
    // terminal one-way.
    claim.status = LockedClaimStatus::Abandoned;
    claim.recovered_at = Some(now);
    // settled_at stays None.

    Ok(())
}
