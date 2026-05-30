use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::state::*;
use crate::verify::webauthn::verify_passkey_signed;

#[derive(Accounts)]
pub struct RequestWithdrawal<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// CHECK: instructions sysvar — address-constrained.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RequestWithdrawalArgs {
    pub amount: u64,
    pub destination: Pubkey,
    pub signed_at: i64,
    /// WebAuthn `clientDataJSON` from the browser. Its `challenge` field
    /// must base64url-decode to `sha256(operation_message)`.
    pub client_data_json: Vec<u8>,
    /// WebAuthn `authenticatorData` (37+ bytes).
    pub authenticator_data: Vec<u8>,
}

pub fn handler(ctx: Context<RequestWithdrawal>, args: RequestWithdrawalArgs) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(vault.version == VAULT_VERSION_V2, VaultError::UnsupportedVaultVersion);

    let now = Clock::get()?.unix_timestamp;
    let drift = now.checked_sub(args.signed_at).unwrap_or(i64::MAX).abs();
    require!(drift <= 300, VaultError::PasskeyVerificationFailed);

    // Operation message:
    //   "request_withdrawal" || amount_le || destination_bytes || signed_at_le
    let mut op_msg = Vec::with_capacity(b"request_withdrawal".len() + 8 + 32 + 8);
    op_msg.extend_from_slice(b"request_withdrawal");
    op_msg.extend_from_slice(&args.amount.to_le_bytes());
    op_msg.extend_from_slice(args.destination.as_ref());
    op_msg.extend_from_slice(&args.signed_at.to_le_bytes());

    verify_passkey_signed(
        &ctx.accounts.instructions_sysvar,
        &vault.passkey_pubkey,
        &args.client_data_json,
        &args.authenticator_data,
        &op_msg,
    )?;

    vault.pending_withdrawal = Some(PendingWithdrawal {
        amount: args.amount,
        destination: args.destination,
        requested_at: args.signed_at,
    });

    Ok(())
}
