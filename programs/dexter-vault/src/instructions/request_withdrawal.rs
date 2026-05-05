use anchor_lang::prelude::*;

use crate::state::*;

#[derive(Accounts)]
pub struct RequestWithdrawal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RequestWithdrawalArgs {
    pub amount: u64,
    pub destination: Pubkey,
}

pub fn handler(_ctx: Context<RequestWithdrawal>, _args: RequestWithdrawalArgs) -> Result<()> {
    Ok(())
}
