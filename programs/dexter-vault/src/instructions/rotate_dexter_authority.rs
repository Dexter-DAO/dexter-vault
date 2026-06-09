use anchor_lang::prelude::*;

use crate::state::*;

#[derive(Accounts)]
pub struct RotateDexterAuthority<'info> {
    #[account(mut, has_one = dexter_authority @ VaultError::PasskeyVerificationFailed)]
    pub vault: Account<'info, Vault>,
    /// Must equal the vault's CURRENT `dexter_authority`. Only the current
    /// authority can hand off to a new one — so the session-master key can be
    /// rotated without bricking existing vaults.
    pub dexter_authority: Signer<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RotateDexterAuthorityArgs {
    pub new_dexter_authority: Pubkey,
}

/// Rotate the Dexter session authority bound to this vault. Gated by the
/// current authority's signature (has_one). Touches only the authority field;
/// never the passkey, the swig, or the counter — and never moves funds.
pub fn handler(
    ctx: Context<RotateDexterAuthority>,
    args: RotateDexterAuthorityArgs,
) -> Result<()> {
    require!(
        args.new_dexter_authority != Pubkey::default(),
        VaultError::PasskeyVerificationFailed
    );
    let vault = &mut ctx.accounts.vault;
    require!(
        vault.version == VAULT_VERSION_V6 || vault.version == VAULT_VERSION_V5 || vault.version == VAULT_VERSION_V4 || vault.version == VAULT_VERSION_V3 || vault.version == VAULT_VERSION_V2,
        VaultError::UnsupportedVaultVersion
    );
    vault.dexter_authority = args.new_dexter_authority;
    Ok(())
}
