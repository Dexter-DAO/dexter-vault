use anchor_lang::prelude::*;

use crate::state::*;

#[derive(Accounts)]
pub struct FinalizeWithdrawal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(_ctx: Context<FinalizeWithdrawal>) -> Result<()> {
    Ok(())
}
