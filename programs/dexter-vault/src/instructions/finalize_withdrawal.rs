use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::state::*;
use crate::verify::webauthn::verify_passkey_signed;

#[derive(Accounts)]
pub struct FinalizeWithdrawal<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// CHECK: instructions sysvar — address-constrained.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

pub fn handler(ctx: Context<FinalizeWithdrawal>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let pending = vault
        .pending_withdrawal
        .clone()
        .ok_or(VaultError::NoPendingWithdrawal)?;

    let now = Clock::get()?.unix_timestamp;
    let elapsed = now.checked_sub(pending.requested_at).unwrap_or(0);
    require!(elapsed >= vault.cooling_off_seconds, VaultError::CoolingOffNotElapsed);
    require!(vault.pending_voucher_count == 0, VaultError::PendingVouchersExist);

    // Reproduce the passkey-signed finalize message:
    //   "finalize_withdrawal" || amount_le || destination_bytes
    let mut msg = Vec::with_capacity(b"finalize_withdrawal".len() + 8 + 32);
    msg.extend_from_slice(b"finalize_withdrawal");
    msg.extend_from_slice(&pending.amount.to_le_bytes());
    msg.extend_from_slice(pending.destination.as_ref());

    verify_passkey_signed(
        &ctx.accounts.instructions_sysvar,
        &vault.passkey_pubkey,
        &msg,
    )?;

    // Funds movement (Swig CPI / sibling instruction) lands in A5. This commit
    // is the state machine: cooling-off + pending-voucher gates + passkey
    // verification of the finalize message.
    vault.pending_withdrawal = None;

    Ok(())
}
