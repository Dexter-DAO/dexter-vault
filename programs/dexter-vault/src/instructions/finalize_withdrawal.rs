use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::state::*;
use crate::verify::webauthn::verify_passkey_signed;

#[derive(Accounts)]
pub struct FinalizeWithdrawal<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// CHECK: must match vault.swig_address (validated in handler). The
    /// Swig program reads the instructions sysvar and recognizes this vault
    /// instruction as the registered ProgramExec authority's marker, then
    /// authorizes a sibling SignV2 instruction in the same transaction.
    pub swig: AccountInfo<'info>,
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

    require!(
        vault.swig_address != Pubkey::default(),
        VaultError::NoPendingWithdrawal
    );
    require!(
        ctx.accounts.swig.key() == vault.swig_address,
        VaultError::PasskeyVerificationFailed
    );

    let now = Clock::get()?.unix_timestamp;
    let elapsed = now.saturating_sub(pending.requested_at).max(0);
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

    // The actual USDC movement happens in a sibling Swig SignV2 instruction
    // sequenced by dexter-api (Task A14). This handler emits the marker
    // instruction; Swig validates the sibling pattern via instruction sysvar
    // introspection and authorizes the inner transfer under the vault's
    // ProgramExecClientRole authority.
    vault.pending_withdrawal = None;

    Ok(())
}
