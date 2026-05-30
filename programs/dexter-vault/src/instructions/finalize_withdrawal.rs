use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::state::*;
use crate::verify::webauthn::verify_passkey_signed;

#[derive(Accounts)]
pub struct FinalizeWithdrawal<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// CHECK: must match vault.swig_address.
    pub swig: AccountInfo<'info>,
    /// CHECK: instructions sysvar — address-constrained.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct FinalizeWithdrawalArgs {
    /// WebAuthn clientDataJSON; challenge must be sha256(operation_message).
    pub client_data_json: Vec<u8>,
    pub authenticator_data: Vec<u8>,
}

pub fn handler(ctx: Context<FinalizeWithdrawal>, args: FinalizeWithdrawalArgs) -> Result<()> {
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
    // i64 unix timestamps minus another i64 timestamp; clamp to non-negative
    // (a future-dated `requested_at` would otherwise wrap), then promote both
    // sides to u64 so the comparison against the u32 cooling-off field is
    // unambiguous and overflow-safe across the full timestamp range.
    let elapsed_secs = now.saturating_sub(pending.requested_at).max(0) as u64;
    require!(
        elapsed_secs >= vault.cooling_off_seconds as u64,
        VaultError::CoolingOffNotElapsed
    );
    require!(vault.pending_voucher_count == 0, VaultError::PendingVouchersExist);
    require!(vault.version == VAULT_VERSION_V2, VaultError::UnsupportedVaultVersion);

    let mut op_msg = Vec::with_capacity(b"finalize_withdrawal".len() + 8 + 32);
    op_msg.extend_from_slice(b"finalize_withdrawal");
    op_msg.extend_from_slice(&pending.amount.to_le_bytes());
    op_msg.extend_from_slice(pending.destination.as_ref());

    verify_passkey_signed(
        &ctx.accounts.instructions_sysvar,
        &vault.passkey_pubkey,
        &args.client_data_json,
        &args.authenticator_data,
        &op_msg,
    )?;

    vault.pending_withdrawal = None;

    Ok(())
}
