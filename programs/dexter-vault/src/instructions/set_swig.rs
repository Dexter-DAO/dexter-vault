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
}

pub fn handler(ctx: Context<SetSwig>, args: SetSwigArgs) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(
        vault.swig_address == Pubkey::default(),
        VaultError::PasskeyVerificationFailed
    );

    // Reproduce the passkey-signed message:
    //   "set_swig" || swig_address_bytes
    let mut msg = Vec::with_capacity(b"set_swig".len() + 32);
    msg.extend_from_slice(b"set_swig");
    msg.extend_from_slice(args.swig_address.as_ref());

    verify_passkey_signed(
        &ctx.accounts.instructions_sysvar,
        &vault.passkey_pubkey,
        &msg,
    )?;

    vault.swig_address = args.swig_address;

    Ok(())
}
