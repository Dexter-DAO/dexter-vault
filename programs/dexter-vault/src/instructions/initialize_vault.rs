use anchor_lang::prelude::*;

use crate::state::*;

#[derive(Accounts)]
#[instruction(args: InitializeVaultArgs)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", args.supabase_user_id.as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializeVaultArgs {
    pub passkey_pubkey: [u8; 33],
    pub cooling_off_seconds: i64,
    pub supabase_user_id: [u8; 16],
}

pub fn handler(ctx: Context<InitializeVault>, args: InitializeVaultArgs) -> Result<()> {
    require!(
        args.passkey_pubkey[0] == 0x02 || args.passkey_pubkey[0] == 0x03,
        VaultError::PasskeyVerificationFailed
    );
    require!(args.cooling_off_seconds >= 0, VaultError::CoolingOffNotElapsed);

    let vault = &mut ctx.accounts.vault;
    vault.bump = ctx.bumps.vault;
    vault.passkey_pubkey = args.passkey_pubkey;
    vault.swig_address = Pubkey::default();
    vault.cooling_off_seconds = args.cooling_off_seconds;
    vault.pending_voucher_count = 0;
    vault.pending_withdrawal = None;
    vault.supabase_user_id = args.supabase_user_id;
    Ok(())
}
