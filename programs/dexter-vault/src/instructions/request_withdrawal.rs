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
    /// Caller-supplied timestamp that was included in the passkey-signed
    /// message. Must match `Clock::get()?.unix_timestamp` to within a small
    /// drift window. The user's client signed the message with this exact
    /// value, so the on-chain handler reproduces the same bytes for the
    /// SIMD-0075 introspection check.
    pub signed_at: i64,
}

pub fn handler(ctx: Context<RequestWithdrawal>, args: RequestWithdrawalArgs) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    let now = Clock::get()?.unix_timestamp;
    let drift = now.checked_sub(args.signed_at).unwrap_or(i64::MAX).abs();
    require!(drift <= 300, VaultError::PasskeyVerificationFailed);

    // Reproduce the message the passkey signed:
    //   "request_withdrawal" || amount_le || destination_bytes || signed_at_le
    let mut msg = Vec::with_capacity(b"request_withdrawal".len() + 8 + 32 + 8);
    msg.extend_from_slice(b"request_withdrawal");
    msg.extend_from_slice(&args.amount.to_le_bytes());
    msg.extend_from_slice(args.destination.as_ref());
    msg.extend_from_slice(&args.signed_at.to_le_bytes());

    verify_passkey_signed(
        &ctx.accounts.instructions_sysvar,
        &vault.passkey_pubkey,
        &msg,
    )?;

    vault.pending_withdrawal = Some(PendingWithdrawal {
        amount: args.amount,
        destination: args.destination,
        requested_at: args.signed_at,
    });

    Ok(())
}
