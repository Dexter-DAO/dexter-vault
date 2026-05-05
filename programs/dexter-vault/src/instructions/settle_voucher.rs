use anchor_lang::prelude::*;

use crate::state::*;

#[derive(Accounts)]
pub struct SettleVoucher<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SettleVoucherArgs {
    pub voucher_hash: [u8; 32],
    pub voucher_amount: u64,
    pub voucher_signature: [u8; 64],
}

pub fn handler(_ctx: Context<SettleVoucher>, _args: SettleVoucherArgs) -> Result<()> {
    Ok(())
}
