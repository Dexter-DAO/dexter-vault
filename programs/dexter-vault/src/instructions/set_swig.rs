use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;

use crate::state::*;
use crate::verify::webauthn::verify_passkey_signed;

#[derive(Accounts)]
pub struct SetSwig<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// CHECK: instructions sysvar — address-constrained.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SetSwigArgs {
    pub swig_address: Pubkey,
    /// WebAuthn `clientDataJSON` produced by the browser. Must contain a
    /// `challenge` field equal to base64url(sha256(operation_message)).
    pub client_data_json: Vec<u8>,
    /// WebAuthn `authenticatorData` produced by the authenticator (37+ bytes).
    pub authenticator_data: Vec<u8>,
}

pub fn handler(ctx: Context<SetSwig>, args: SetSwigArgs) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(
        vault.version == VAULT_VERSION_V3 || vault.version == VAULT_VERSION_V2,
        VaultError::UnsupportedVaultVersion
    );
    require!(
        vault.swig_address == Pubkey::default(),
        VaultError::PasskeyVerificationFailed
    );

    // Operation message: "set_swig" || swig_address_bytes
    let mut op_msg = Vec::with_capacity(b"set_swig".len() + 32);
    op_msg.extend_from_slice(b"set_swig");
    op_msg.extend_from_slice(args.swig_address.as_ref());

    verify_passkey_signed(
        &ctx.accounts.instructions_sysvar,
        &vault.passkey_pubkey,
        &args.client_data_json,
        &args.authenticator_data,
        &op_msg,
    )?;

    vault.swig_address = args.swig_address;

    Ok(())
}
