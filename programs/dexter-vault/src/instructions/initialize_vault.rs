use anchor_lang::prelude::*;

use crate::state::*;

#[derive(Accounts)]
#[instruction(args: InitializeVaultArgs)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Vault::INIT_SPACE,
        // Seeds use only the leading 16 bytes of identity_claim so existing
        // operator integrations (which keyed PDAs on a 16-byte Supabase UUID
        // under v1) keep the same derivation. The remaining 16 bytes of the
        // claim are advisory storage only.
        seeds = [b"vault", &args.identity_claim[..16]],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The Dexter session authority to bind to this vault. Must sign init, so
    /// a vault can only be created bound to an authority that consented. This
    /// key may later mutate `pending_voucher_count` (settle_voucher /
    /// force_release) — and only this key. It can never move funds.
    pub dexter_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializeVaultArgs {
    pub passkey_pubkey: [u8; 33],
    /// Withdrawal cooling-off in seconds. Zero = instant. See §7.1 of the v2
    /// design doc for why this tightened from i64 to u32.
    pub cooling_off_seconds: u32,
    /// Operator-defined opaque identity bytes. The protocol doesn't interpret
    /// these. Dexter writes a Supabase UUID into the first 16 bytes and zeros
    /// the rest; future operators may use whichever scheme they want.
    pub identity_claim: [u8; 32],
}

pub fn handler(ctx: Context<InitializeVault>, args: InitializeVaultArgs) -> Result<()> {
    require!(
        args.passkey_pubkey[0] == 0x02 || args.passkey_pubkey[0] == 0x03,
        VaultError::PasskeyVerificationFailed
    );

    let vault = &mut ctx.accounts.vault;
    vault.version = VAULT_VERSION_V4;
    vault.bump = ctx.bumps.vault;
    vault.passkey_pubkey = args.passkey_pubkey;
    vault.swig_address = Pubkey::default();
    vault.cooling_off_seconds = args.cooling_off_seconds;
    vault.pending_voucher_count = 0;
    vault.pending_withdrawal = None;
    vault.identity_claim = args.identity_claim;
    vault.dexter_authority = ctx.accounts.dexter_authority.key();
    vault.live_session_count = 0;
    Ok(())
}
