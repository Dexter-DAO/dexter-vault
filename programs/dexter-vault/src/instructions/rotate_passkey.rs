use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::state::*;
use crate::verify::webauthn::verify_passkey_signed;

#[derive(Accounts)]
pub struct RotatePasskey<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// CHECK: instructions sysvar — address-constrained. Verifies the buyer's
    /// CURRENT passkey signature via the SIMD-0075 precompile sibling.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RotatePasskeyArgs {
    pub new_passkey_pubkey: [u8; 33],
    /// WebAuthn clientDataJSON; challenge must be sha256(operation_message).
    pub client_data_json: Vec<u8>,
    pub authenticator_data: Vec<u8>,
}

/// Rotate the buyer's passkey. The CURRENT passkey must sign (proving the
/// buyer owns the key being replaced); the new key takes effect on success.
/// This is the recovery path for "I want to move my vault to a new device /
/// passkey" without losing the vault. Touches only the passkey field — never
/// the swig, the authority, or the counter, and never moves funds.
pub fn handler(ctx: Context<RotatePasskey>, args: RotatePasskeyArgs) -> Result<()> {
    require!(
        args.new_passkey_pubkey[0] == 0x02 || args.new_passkey_pubkey[0] == 0x03,
        VaultError::PasskeyVerificationFailed
    );

    let vault = &mut ctx.accounts.vault;
    require!(
        vault.version == VAULT_VERSION_V3 || vault.version == VAULT_VERSION_V2,
        VaultError::UnsupportedVaultVersion
    );

    // The CURRENT passkey must sign "rotate_passkey" || new_passkey_pubkey.
    let mut op_msg = Vec::with_capacity(b"rotate_passkey".len() + 33);
    op_msg.extend_from_slice(b"rotate_passkey");
    op_msg.extend_from_slice(&args.new_passkey_pubkey);

    verify_passkey_signed(
        &ctx.accounts.instructions_sysvar,
        &vault.passkey_pubkey,
        &args.client_data_json,
        &args.authenticator_data,
        &op_msg,
    )?;

    vault.passkey_pubkey = args.new_passkey_pubkey;

    Ok(())
}
