use anchor_lang::prelude::*;

use crate::state::*;

#[derive(Accounts)]
pub struct InitializeVault<'info> {
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

pub fn handler(_ctx: Context<InitializeVault>, _args: InitializeVaultArgs) -> Result<()> {
    Ok(())
}
